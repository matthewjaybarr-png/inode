// Inode: two panes side by side, a places sidebar, keyboard-first.
import { Pane } from './pane.js';
import { extOf, kindOf, formatSize, formatDate, formatMode, sidebarModel, moved, BIN, TRASH, RECENT, placeName, isFolder, isAddress, archiveStem, ALIAS, exportSettings, importSettings } from './util.js';
import { followDesktopTheme, openThemePicker } from './theme.js';
import { setupOps } from './ops.js';
import { setupExtras } from './extras.js';
import { setupAddons } from './addons.js';
import { setupDnd } from './dnd.js';
import { icon, iconFor } from './icons.js';
import { ACTIONS, PRESETS, buildMap, lookup, keysFor, comboOf, label } from './keys.js';
import { setupNet } from './net.js';
import { setupPick } from './pick.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const $ = (s) => document.querySelector(s);

import { IMAGES, VIEW_DEFAULTS, COLUMNS, shownCols, WIN, TAGS } from './util.js';
const note = (t) => Object.assign(document.createElement('div'), { className: 'pv-note', textContent: t });
const STORE = 'folyren-files:state';
const TRASH_LABEL = `Delete (to ${BIN})`;
const defaults = { sort: { key: 'name', reverse: false }, hidden: false, dual: true, split: 0.5, focus: 0, paths: [], tabs: [], pins: [], side: { hide: [], fold: ['Places', 'Drives'], v: 1 }, manage: false, preview: false, cols: {}, pvw: 320, preset: 'default', keys: {}, aliases: {}, askBin: false, warnExt: true, recents: [], restoreTabs: true, actionOpts: {} };
// What every window shares; the rest (tabs, layout) is each window's own. See the 'storage' listener in start().
const SHARED = ['pins', 'side', 'keys', 'preset', 'aliases', 'recents', 'askBin', 'warnExt', 'restoreTabs', 'folders', 'actionOpts'];
// Places and Drives start folded (a busy sidebar is hard to scan); v marks profiles that already got that default once.
const fresh = (s) => (s.side?.v ? s : { ...s, side: { hide: s.side?.hide || [], fold: [...new Set([...(s.side?.fold || []), 'Places', 'Drives'])], v: 1 } });
const load = () => { try { return fresh({ ...defaults, ...JSON.parse(localStorage.getItem(STORE) || '{}') }); } catch { return { ...defaults }; } };

Object.assign(defaults, structuredClone(VIEW_DEFAULTS)); // list/grid, columns, sort options, per-folder views
const app = {
  state: load(),
  panes: [],
  home: '',
  active: 0,

  saveState() {
    if (this.pick) return; // another app's file chooser (pick.js) leaves no trace in the saved state
    // A window opened for a folder (guest) leaves the remembered tabs alone: the next plain start reopens the main window's.
    if (!this.guest) {
      this.state.paths = this.panes.map((p) => p.path);
      this.state.tabs = this.panes.map((p) => ({ paths: p.tabs.map((t) => t.path), idx: p.tabIdx }));
      this.state.focus = this.active;
    }
    try { localStorage.setItem(STORE, JSON.stringify(this.state)); } catch { /* private mode: nothing to keep */ }
  },

  focus(side, fromEvent) {
    if (!this.state.dual) side = 0;
    this.active = side;
    this.panes.forEach((p, i) => p.root.classList.toggle('active', i === side));
    if (!fromEvent) this.panes[side].list.focus();
    this.status(); this.saveState();
  },
  other() { return this.panes[1 - this.active]; },
  pane() { return this.panes[this.active]; },

  setSort(key) {
    const s = this.pane().sort;
    this.pane().setView({ sort: s.key === key ? { key, reverse: !s.reverse } : { key, reverse: false } });
  },
  // After a view setting changed: column tracks, both panes, saved.
  redraw() { this.layout(); this.panes.forEach((p) => p.path != null && p.render(p.rows[p.cursor]?.path)); this.saveState(); },
  // Flips a saved view setting (a column, a sort option, per-folder views).
  toggleView(key, name) {
    if (WIN && key === 'colMode') return this.flash('Permissions is a Linux column: Windows folders have none to show');
    this.state[key] = !this.state[key];
    this.redraw(); this.flash(`${name}: ${this.state[key] ? 'on' : 'off'}`);
  },
  toggleHidden() {
    this.state.hidden = !this.state.hidden;
    this.panes.forEach((p) => p.render(p.rows[p.cursor]?.path));
    this.flash(this.state.hidden ? 'Showing hidden items' : 'Hiding hidden items');
    this.saveState();
  },
  toggleDual() {
    this.state.dual = !this.state.dual;
    this.layout();
    if (this.state.dual && this.panes[1].path == null) this.panes[1].go(this.panes[0].path, { push: false });
    this.focus(this.state.dual ? this.active : 0);
  },
  // Left folder goes right and right goes left; focus stays on the same side.
  async swap() {
    const [a, b] = this.panes;
    if (!this.state.dual || a.path == null || b.path == null) return;
    const pa = a.path;
    await Promise.all([a.go(b.path), b.go(pa)]);
    this.focus(this.active);
  },
  layout() {
    const m = $('#panes');
    m.classList.toggle('single', !this.state.dual);
    $('#btn-dual').setAttribute('aria-pressed', String(this.state.dual));
    $('#btn-swap').disabled = !this.state.dual;
    const f = Math.min(0.85, Math.max(0.15, this.state.split));
    m.style.gridTemplateColumns = this.state.dual ? `minmax(0, ${f}fr) 6px minmax(0, ${1 - f}fr)` : 'minmax(0, 1fr)';
    for (const k of ['name', ...Object.keys(COLUMNS)]) {
      const w = this.state.cols[k];
      if (w) m.style.setProperty(`--w-${k}`, `${w}px`); else m.style.removeProperty(`--w-${k}`);
    }
    // Name grows only up to --w-name; the spare width goes to an empty last track so Name and the next column stay close.
    m.style.setProperty('--cols', ['minmax(120px, var(--w-name, 420px))', ...shownCols(this.state).map((k) => `var(--w-${k}, ${COLUMNS[k][2]}px)`), 'minmax(0, 1fr)'].join(' '));
    $('#preview').style.width = `${Math.min(900, Math.max(200, this.state.pvw))}px`;
  },
  // A drag handle: `set(width)` while dragging, `reset()` on double-click; `start()` gives the width at pointer down.
  grip(set, start, reset, sign = 1) {
    const g = Object.assign(document.createElement('span'), { className: 'grip', title: 'Drag to resize; double-click to reset' });
    g.onclick = (e) => e.stopPropagation();
    g.ondblclick = (e) => { e.stopPropagation(); reset(); this.layout(); this.saveState(); };
    g.onpointerdown = (e) => {
      e.stopPropagation(); e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('drag');
      const x0 = e.clientX, w0 = start();
      g.onpointermove = (ev) => { set(Math.round(w0 + sign * (ev.clientX - x0))); this.layout(); };
      g.onpointerup = () => { g.onpointermove = null; g.classList.remove('drag'); this.saveState(); };
    };
    return g;
  },

  status() {
    const p = this.pane();
    if (!p || p.path == null) return;
    const sel = p.selected.size, n = p.rows.length;
    const hiddenCount = p.entries.length - (this.state.hidden ? p.entries.length : p.entries.filter((e) => !e.hidden).length);
    $('#status-left').textContent = `${this.state.dual ? `${this.active ? 'Right' : 'Left'} pane · ` : ''}${p.filter ? `${n} of ${p.total} shown` : `${n} item${n === 1 ? '' : 's'}`}${sel ? ` · ${sel} selected` : ''}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}`;
    if (!this.flashing) $('#status-right').textContent = placeName(p.path) ?? p.path;
    this.actionBar(p);
    if (this.state.preview) { clearTimeout(this.previewT); this.previewT = setTimeout(() => this.showPreview(p.rows[p.cursor]), 120); }
  },
  // New folder / New file / Delete state for the active pane. A disabled button can't show a tooltip, so the reason is spelled out beside it.
  actionBar(p = this.pane()) {
    const ok = isFolder(p.path), bin = p.path === TRASH, n = ok || bin ? p.targets().length : 0, nf = $('#btn-new'), file = $('#btn-newfile'), del = $('#btn-trash');
    const off = `${placeName(p.path) ?? 'This'} is a list, not a folder; open a drive or folder to make something in it`;
    nf.disabled = file.disabled = !ok; del.disabled = !n;
    del.textContent = `Delete${bin ? ' permanently' : ''}${n > 1 ? ` (${n})` : ''}`;
    del.title = !n ? 'Nothing to delete: select a file or folder first'
      : bin ? `Delete ${n === 1 ? 'the item under the cursor' : `${n} selected items`} from the ${BIN} permanently (Delete). It asks first.`
        : `Move ${n === 1 ? 'the item under the cursor' : `${n} selected items`} to the ${BIN} (Delete). Shift+Delete deletes permanently.`;
    nf.title = ok ? `New folder in ${p.path} (Ctrl+Shift+N)` : off;
    file.title = ok ? `New file in ${p.path} (Ctrl+Alt+N)` : off;
    $('#act-where').textContent = ok ? `${this.state.dual ? `${this.active ? 'Right' : 'Left'} pane: ` : ''}${p.path}${n ? ` · ${n} ${document.body.classList.contains('picking') ? 'selected' : 'to delete'}` : ' · nothing selected'}`
      : bin ? `${BIN}: right-click an item to restore it; right-click empty space to restore everything or empty it`
        : p.path.startsWith(TAGS) ? 'Tagged items, wherever they are: right-click one to open its folder or change its tag. Nothing can be made here.'
        : p.path === RECENT ? 'Recent: files used lately, newest first; right-click one to open its folder. Nothing can be made here.'
          : 'This PC: open a drive or folder to make a new folder there';
  },
  flash(msg) {
    clearTimeout(this.flashing);
    $('#status-right').textContent = msg;
    this.flashing = setTimeout(() => { this.flashing = null; this.status(); }, 3500);
  },

  async eject(pl, btn) {
    btn.disabled = true; this.flash(`Ejecting ${pl.name}…`);
    const home = this.places.find((p) => p.kind === 'home')?.path || '';
    const root = /[\\/]$/.test(pl.path) ? pl.path : `${pl.path}/`, under = (path) => path && (path === pl.path || path.toLowerCase().startsWith(root.toLowerCase()));
    // A pane showing the drive would keep it busy; send it back to where it was before (a locked folder's own folder), else home.
    await Promise.all(this.panes.filter((p) => under(p.path)).map((p) => p.go(p.back.findLast((b) => !under(b)) || home)));
    try {
      await invoke('eject', { path: pl.path });
      this.flash(pl.kind === 'vault' ? `${pl.name} is locked again` : `${pl.name} can be removed now`);
      this.renderPlaces(await invoke('places'));
    } catch (e) {
      btn.disabled = false; this.flash(`Could not eject ${pl.name}: ${e}`);
    }
  },

  renderPlaces(places = this.places) {
    this.places = places;
    const nav = $('#sidebar'), side = this.state.side;
    const keep = document.activeElement?.closest?.('#sidebar') ? document.activeElement.dataset.key : null;
    nav.replaceChildren();
    const { groups, hidden } = sidebarModel(this.state.pins, places, side);
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
    const flip = (list, v) => { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); else list.push(v); this.renderPlaces(); this.saveState(); };
    for (const g of groups) {
      const h = el('button', 'group', g.name);
      h.dataset.key = `g:${g.name}`; h.setAttribute('aria-expanded', String(!g.folded)); h.title = g.folded ? `Show ${g.name}` : `Fold ${g.name}`;
      h.onclick = () => flip(side.fold, g.name);
      nav.append(h);
      if (g.folded) continue;
      if (!g.items.length) nav.append(el('div', 'side-note', 'No pins yet. Right-click a folder or file and choose Pin to sidebar.'));
      for (const pl of g.items) {
        const row = el('div', 'side-row'), b = el('button', `place k-${pl.kind}`, pl.name), more = el('button', 'more', '⋯');
        b.prepend(icon(pl.kind)); b.dataset.drop = pl.path; b.dataset.key = `${pl.kind === 'pin' ? 'p' : 'l'}:${pl.path}`; b.title = pl.title || pl.path || 'This PC';
        b.onclick = () => { if (b.dataset.kind === 'file') return this.openPinned(pl.path, b); this.goPlace(pl.path).then((ok) => { if (isFolder(pl.path) && pl.kind !== 'trash' && b.isConnected) this.checkPin(pl.path, b, pl.title || pl.path); if (ok && pl.kind === 'phone' && isFolder(pl.path) && !this.pane().entries.length) this.flash(this.net.phoneNote); }); };
        more.title = `Options for ${pl.name}`; more.setAttribute('aria-label', more.title); more.setAttribute('aria-haspopup', 'menu');
        const menu = (at) => this.sideMenu(at, pl);
        more.onclick = () => menu(more); row.oncontextmenu = (e) => { e.preventDefault(); menu(more); };
        row.append(b);
        if (pl.eject) {
          const ej = el('button', 'eject', '');
          ej.append(icon('eject')); ej.title = `Eject ${pl.name}`; ej.setAttribute('aria-label', ej.title);
          ej.onclick = () => this.eject(pl, ej);
          row.append(ej);
        }
        row.append(more); nav.append(row);
        if (pl.kind === 'pin' || pl.kind === 'drive' || pl.kind === 'network') this.checkPin(pl.path, b, b.title);
      }
    }
    this.tagPlaces?.(nav, flip); // the Tags section (addons.js)
    // Manage sidebar: always there, so what is hidden can always be found again.
    const m = el('button', 'group manage', hidden.length ? `Manage sidebar · ${hidden.length} hidden` : 'Manage sidebar');
    m.dataset.key = 'manage'; m.setAttribute('aria-expanded', String(this.state.manage));
    m.onclick = () => { this.state.manage = !this.state.manage; this.renderPlaces(); this.saveState(); };
    nav.append(m);
    if (this.state.manage) {
      if (!hidden.length) nav.append(el('div', 'side-note', 'Nothing is hidden. Use ⋯ or right-click on a place or drive to hide it. Hiding never disconnects anything.'));
      for (const pl of hidden) {
        const row = el('div', 'side-row hidden-row'), b = el('button', 'place', pl.name || 'This PC'), show = el('button', 'show', 'Show');
        b.dataset.key = `h:${pl.path}`; b.title = `${pl.path || 'This PC'} (hidden from the sidebar; click to open it)`;
        b.onclick = () => this.goPlace(pl.path);
        show.setAttribute('aria-label', `Show ${pl.name} in the sidebar`); show.onclick = () => flip(side.hide, pl.path);
        row.append(b, show); nav.append(row);
      }
      if (hidden.length > 1) { const all = el('button', 'place show-all', 'Show all'); all.dataset.key = 'showall'; all.onclick = () => { side.hide.length = 0; this.renderPlaces(); this.saveState(); }; nav.append(all); }
    }
    if (keep) [...nav.querySelectorAll('[data-key]')].find((x) => x.dataset.key === keep)?.focus();
  },
  // Opens a sidebar place in the active pane.
  async goPlace(path) {
    const done = this.pane().go(path);
    if (!isAddress(path)) this.focus(this.active); // a server or locked drive first opens a box of its own (net.js), which keeps the focus
    return done;
  },
  goKind(kind) {
    const pl = this.places.find((p) => p.kind === kind);
    if (pl) return this.goPlace(pl.path);
  },
  // The folder an item lives in, with the item selected (Recent, search results).
  async openFolder(e = this.pane().rows[this.pane().cursor]) {
    const p = this.pane();
    if (!e || !p.path || p.path === TRASH) return;
    if (await p.go(e.path.replace(/[\\/][^\\/]*$/, '') || '/', { keep: e.path })) { p.selected = new Set([e.path]); p.paintCursor(false); }
  },
  // A pin on a drive that is away stays in the list, marked; the check runs off the UI so a dead share cannot freeze the app.
  checkPin(path, button, tip = path) {
    invoke('probe', { path }).then((kind) => {
      const ok = !!kind;
      if (ok) button.dataset.kind = kind; // an away pin keeps its last kind, so a click still opens a file the right way
      button.classList.toggle('file', button.dataset.kind === 'file');
      if (button.classList.contains('k-pin')) button.querySelector('.ico')?.replaceWith(icon(button.dataset.kind === 'file' ? iconFor(path, false) : 'folder'));
      button.classList.toggle('away', !ok);
      button.title = ok ? tip : `${tip}\nNot reachable right now. Click to try again.`;
    }).catch(() => {});
  },
  // A pinned file opens in its own app, like a double-click in the list.
  openPinned(path, button) {
    invoke('open_path', { path }).catch((e) => this.flash(`Could not open ${path}: ${e}`));
    this.checkPin(path, button, path);
  },
  sideMenu(at, pl) {
    const side = this.state.side, pins = this.state.pins, pin = pl.kind === 'pin', i = pins.indexOf(pl.path);
    const act = (fn) => () => { this.closeSideMenu(); fn(); this.renderPlaces(); this.saveState(); };
    const items = pin
      ? [['Move up', act(() => { this.state.pins = moved(pins, pl.path, -1); }), i === 0],
         ['Move down', act(() => { this.state.pins = moved(pins, pl.path, 1); }), i === pins.length - 1],
         ['Try again', () => { this.closeSideMenu(); if (at.previousElementSibling?.dataset.kind !== 'file') this.pane().go(pl.path); this.renderPlaces(); }],
         ['Unpin', () => { this.closeSideMenu(); this.togglePin(pl.path); }]]
      : [[i >= 0 ? 'Unpin' : 'Pin to top', () => { this.closeSideMenu(); this.togglePin(pl.path); }, !isFolder(pl.path) || pl.kind === 'trash'],
         ['Hide from sidebar', act(() => { side.hide.push(pl.path); this.flash(`${pl.name} is hidden. Manage sidebar shows it again.`); })]];
    this.popMenu(at.getBoundingClientRect(), items, at);
  },
  // Right-click in a list: on an item (`entry`) or on empty space (no entry). Every item is an existing command, shown with its key.
  entryMenu(ev, entry) {
    const act = (id) => ACTIONS.find((a) => a.id === id);
    const it = (text, id, off) => { const c = keysFor(act(id), this.state.preset, this.state.keys)[0]; return [text, () => { this.closeSideMenu(); act(id).run(this); }, off, c ? label(c) : '']; };
    const pinned = (p) => this.state.pins.includes(p), two = !this.state.dual;
    const own = (text, run, off, id) => { const c = id && keysFor(act(id), this.state.preset, this.state.keys)[0]; return [text, () => { this.closeSideMenu(); run(); }, off, c ? label(c) : '']; };
    const here = this.pane().path, none = !this.pane().entries.length;
    const props = () => own('Properties', () => this.showProps(entry), false, 'properties');
    const stem = entry && !entry.dir ? archiveStem(entry.name) : '';
    const items = here === TRASH ? (entry
      ? [it('Restore', 'restore'), it('Delete permanently', 'deleteForever'), null, props()]
      : [it('Restore all', 'restoreAll', none), it(`Empty ${BIN}`, 'emptyTrash', none), null, it('Refresh', 'refresh')])
      : here === RECENT || here?.startsWith(TAGS) ? (entry
        ? [it('Open', 'open'), !entry.dir && own('Open with…', () => this.openWith(entry.path, ev)), it('Open containing folder', 'openFolder'), null,
           it('Copy', 'copy'), it('Copy path', 'copyPath'), it('Copy to other pane', 'copyOther', two), null, props()]
        : [it('Refresh', 'refresh')])
      : entry
      ? [it('Open', 'open'), !entry.dir && own('Open with…', () => this.openWith(entry.path, ev)), entry.dir && it('Open in new tab', 'openNewTab'), entry.dir && own('Open in terminal', () => this.openTerminal(entry.path)), null,
         it('Cut', 'cut'), it('Copy', 'copy'), entry.dir && own('Paste into folder', () => this.ops.paste(entry.path)), it('Copy path', 'copyPath'), null,
         it('Copy to other pane', 'copyOther', two), it('Move to other pane', 'moveOther', two), null,
         it('Rename', 'rename'), it('Create shortcut', 'shortcut'), it('Compress to .zip', 'compress'), entry.dir && navigator.platform.startsWith('Linux') && own('Lock with password…', () => this.net.lockExisting(entry.path)), !!stem && it('Extract here', 'extractHere'), !!stem && it(`Extract to folder ${stem}`, 'extractTo'), it(pinned(entry.path) ? 'Unpin from sidebar' : 'Pin to sidebar', 'pinItem'), it(TRASH_LABEL, 'trash'), null,
         it(this.state.preview ? 'Hide preview' : 'Show preview', 'preview'), props()]
      : [it('New folder', 'newFolder'), it('New file', 'newFile'), navigator.platform.startsWith('Linux') && it('New locked folder…', 'newLocked'), it('Paste', 'paste'), null,
         it('Open in terminal', 'terminal'), own('Copy folder path', () => this.copyPath([here])), it(pinned(here) ? 'Unpin this folder' : 'Pin this folder', 'pin'), it('Alias this folder…', 'alias'), null,
         it('Show / hide hidden items', 'hidden'), it(this.state.preview ? 'Hide preview' : 'Show preview', 'preview'), it('Refresh', 'refresh'), null,
         own('Folder properties', () => this.showProps({ name: here.split(/[\\/]/).filter(Boolean).pop() || here, path: here, dir: true }))];
    if (entry && here !== TRASH) items.push(null, this.tagRow(), ...this.actionItems()); // colour tags, then the custom actions that fit (addons.js)
    this.popMenu({ left: ev.clientX, top: ev.clientY, bottom: ev.clientY }, items, this.pane().list);
  },
  // Shift+F10 / Menu key: the item menu at the cursor row (empty-space menu if the folder is empty).
  cursorMenu() {
    const p = this.pane(), e = p.rows[p.cursor], row = e && p.list.children[p.cursor];
    const r = (row || p.list).getBoundingClientRect();
    this.entryMenu({ clientX: r.left + 24, clientY: row ? r.bottom : r.top + 8 }, e || null);
  },
  // Linux: suggested apps, then "Choose another app…" (every app). Windows (no list): the system's Open With dialog.
  async openWith(path, at) {
    const run = (app) => () => { this.closeSideMenu(); invoke('open_with', { path, app }).catch((e) => this.flash(`Could not open: ${e}`)); };
    const apps = await invoke('apps_for', { path }).catch(() => []);
    if (!apps.length) return run(null)();
    const r = { left: at.clientX, top: at.clientY, bottom: at.clientY }, list = this.pane().list;
    const fits = apps.filter((a) => a.fit), all = apps.map((a) => [a.name, run(a.id)]);
    this.popMenu(r, [...(fits.length ? fits.map((a) => [a.default ? `${a.name} (default)` : a.name, run(a.id)]) : [['No suggested apps', null, true]]), null,
      ['Choose another app…', () => this.popMenu(r, all, list)]], list);
  },
  // Properties of an entry (Alt+Enter: the cursor item, else this folder). Totals a folder off the UI thread.
  async showProps(e) {
    const p = this.pane();
    e ||= p.rows[p.cursor] || { name: p.path, path: p.path, dir: true };
    const box = $('#props'), dl = box.querySelector('dl');
    const row = (k, v) => { if (v) dl.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })); };
    const when = (ms) => (ms ? new Date(ms).toLocaleString() : '');
    const fill = (pr) => {
      dl.replaceChildren();
      row('Kind', kindOf(e)); row('Location', e.path.replace(/[\\/][^\\/]*[\\/]?$/, '') || (e.path.startsWith('/') ? '/' : e.path));
      row('Size', !pr ? 'Counting…' : pr.error || `${formatSize(pr.size)}${pr.size >= 1024 ? ` (${pr.size.toLocaleString()} bytes)` : ''}`);
      if (e.dir && pr && !pr.error) row('Contains', `${pr.files.toLocaleString()} files, ${pr.folders.toLocaleString()} folders`);
      row('Modified', when(pr?.mtime)); row('Created', when(pr?.ctime));
      if (pr?.mode != null) row('Permissions', formatMode(pr.mode));
    };
    box.querySelector('strong').textContent = e.name;
    box.querySelector('.props-close').onclick = () => this.hideProps();
    box.onclick = (ev) => { if (ev.target === box) this.hideProps(); }; // a click outside the card closes it
    fill(null); box.hidden = false; box.querySelector('.props-close').focus();
    this.propsFor = e.path;
    const pr = await invoke('props', { path: e.path }).catch((err) => ({ error: String(err) }));
    if (this.propsFor === e.path && !box.hidden) fill(pr);
  },
  hideProps() { $('#props').hidden = true; this.propsFor = null; this.pane().list.focus(); },
  copyPath(paths = this.pane().targets()) {
    if (!paths.length) return;
    const text = paths.join('\n'), done = () => this.flash(paths.length === 1 ? `Copied ${paths[0]}` : `Copied ${paths.length} paths`);
    navigator.clipboard.writeText(text).then(done, () => {
      // Fallback for webviews that refuse the async clipboard.
      const t = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(t); t.select(); const ok = document.execCommand('copy'); t.remove();
      ok ? done() : this.flash('Could not reach the clipboard');
      this.pane().list.focus();
    });
  },
  newWindow() {
    invoke('new_window', { path: this.pane().path }).catch((e) => this.flash(`Could not open a window: ${e}`));
  },
  openTerminal(dir = this.pane().path) {
    if (isFolder(dir)) invoke('open_terminal', { dir }).catch((e) => this.flash(`Could not open a terminal: ${e}`));
  },
  // Small popup menu; items are [text, run, disabled, key], null for a separator, or a ready-made element (the tag row). `back` gets focus on Escape.
  popMenu(r, items, back) {
    this.closeSideMenu();
    const box = Object.assign(document.createElement('div'), { id: 'side-menu' });
    box.setAttribute('role', 'menu');
    for (const item of items.filter((x) => x !== false)) {
      if (!item) { box.append(document.createElement('hr')); continue; } // null = separator
      if (item instanceof Node) { box.append(item); continue; }
      const [text, run, off, key] = item;
      const b = Object.assign(document.createElement('button'), { textContent: text, disabled: !!off, onclick: run });
      if (key) b.append(Object.assign(document.createElement('span'), { className: 'key', textContent: key }));
      b.setAttribute('role', 'menuitem'); box.append(b);
    }
    box.style.left = `${Math.max(4, r.left)}px`; box.style.top = `${r.bottom + 2}px`;
    document.body.append(box);
    if (box.getBoundingClientRect().right > innerWidth) box.style.left = `${Math.max(4, innerWidth - box.offsetWidth - 4)}px`;
    if (box.getBoundingClientRect().bottom > innerHeight) box.style.top = `${Math.max(4, r.top - box.offsetHeight - 2)}px`;
    const btns = () => [...box.querySelectorAll('button:not(:disabled)')];
    box.onkeydown = (e) => {
      const l = btns(), n = l.indexOf(document.activeElement);
      if (e.key === 'Escape') { this.closeSideMenu(); back.focus(); }
      else if (e.key === 'ArrowDown') l[(n + 1) % l.length].focus();
      else if (e.key === 'ArrowUp') l[(n - 1 + l.length) % l.length].focus();
      else if (e.key !== 'Enter' && e.key !== ' ') return;
      else return e.stopPropagation(); // Enter/Space press the focused item, not a pane command
      e.preventDefault(); e.stopPropagation();
    };
    btns()[0]?.focus();
    setTimeout(() => addEventListener('pointerdown', this.sideMenuOff = (e) => { if (!box.contains(e.target)) this.closeSideMenu(); }, true));
  },
  closeSideMenu() {
    document.getElementById('side-menu')?.remove();
    if (this.sideMenuOff) { removeEventListener('pointerdown', this.sideMenuOff, true); this.sideMenuOff = null; }
  },
  togglePin(path) {
    if (path == null) return;
    const pins = this.state.pins, i = pins.indexOf(path);
    if (i < 0 && !isFolder(path)) return this.flash('Only real folders and files can be pinned');
    if (i >= 0) pins.splice(i, 1); else pins.push(path);
    this.flash(i >= 0 ? 'Unpinned from the sidebar' : 'Pinned to the sidebar');
    this.renderPlaces(); this.panes.forEach((p) => p.renderTabs()); this.saveState();
  },

  // Folder aliases (state.aliases: name -> folder), typed as @name in the path bar. An empty name removes this folder's.
  // False = the name was refused, so the name box stays open.
  setAlias(name, path) {
    const a = this.state.aliases, n = name.replace(/^@/, '').toLowerCase(), old = Object.keys(a).filter((k) => a[k] === path);
    if (n && !ALIAS.test(n)) { this.flash('An alias name is letters, digits, - or _ (no spaces)'); return false; }
    if (!n) { for (const k of old) delete a[k]; this.flash(old.length ? `Removed alias @${old.join(', @')}` : 'This folder had no alias to remove'); }
    else { const was = a[n]; a[n] = path; this.flash(was && was !== path ? `@${n} replaced: it was ${was}, now ${path}` : `@${n} now goes to ${path}`); }
    this.saveState(); return true;
  },
  aliasHint(start) {
    const all = { h: this.home, ...this.state.aliases }, hit = Object.keys(all).filter((k) => k.startsWith(start.toLowerCase()));
    return hit.length ? hit.map((k) => `@${k} = ${all[k]}`).join(' · ') : `No alias starts with @${start}`;
  },
  toggleSetting(key, on, off) {
    this.state[key] = !this.state[key];
    this.flash(this.state[key] ? on : off); this.saveState();
  },
  // Export: everything the user set up, as inode-settings.json in the active pane's folder, selected.
  async exportSettings() {
    const p = this.pane();
    if (!isFolder(p.path)) return this.flash(`${placeName(p.path) ?? 'This'} is a list, not a folder: open a folder to export the settings into it`);
    try {
      const theme = (await invoke('theme_choice')).own ?? null;
      const path = await invoke('save_settings', { dir: p.path, text: JSON.stringify(exportSettings(this.state, theme), null, 2) });
      if (await p.go(p.path, { push: false, keep: path })) { p.selected = new Set([path]); p.paintCursor(false); }
      if (this.other().path === p.path) this.other().refresh();
      this.flash(`Exported the settings to ${path}`);
    } catch (e) { this.flash(`Could not export the settings: ${e}`); }
  },
  // Import: the selected .json in the active pane. A file of the wrong shape changes nothing and says why.
  async importSettings() {
    const [path, more] = this.pane().targets();
    if (!path || more || extOf(path) !== 'json') return this.flash('Select one .json settings file first (Export settings makes one)');
    // shortcut: read_text stops at 64 KB (a settings file is a few KB) and a cut-off file is refused as invalid JSON; read it whole if settings ever grow.
    const text = await invoke('read_text', { path }).catch(() => null);
    const r = text == null ? { error: 'it cannot be read as text' } : importSettings(text);
    if (r.error) return this.flash(`Nothing imported: ${r.error}`);
    Object.assign(this.state, r.settings);
    let theme = '';
    if (r.theme !== undefined) await invoke('set_theme_choice', { scope: 'app', value: r.theme }).catch((e) => { theme = ` (the theme could not be set: ${e})`; });
    this.rebuildKeys(); this.renderPlaces(); this.layout();
    $('#preview').hidden = !this.state.preview; $('#btn-preview').setAttribute('aria-pressed', String(this.state.preview));
    if (this.state.dual && this.panes[1].path == null) await this.panes[1].go(this.panes[0].path, { push: false });
    this.panes.forEach((p) => { p.render(p.rows[p.cursor]?.path); p.renderTabs(); });
    this.focus(this.active);
    this.flash(`Imported ${r.said.join(', ')} from ${path.split(/[\\/]/).pop()}${theme}`);
  },

  // Preview column: text, images and PDFs of the item under the cursor.
  // Details: several selected = their count and size; nothing under the cursor = this folder.
  togglePreview() {
    this.state.preview = !this.state.preview;
    $('#preview').hidden = !this.state.preview;
    $('#btn-preview').setAttribute('aria-pressed', String(this.state.preview));
    this.saveState(); this.status();
  },
  async showPreview(e, p = this.pane()) {
    const box = $('#preview-body'), head = $('#preview-head');
    const t = ++this.previewSeq;
    box.replaceChildren(); head.replaceChildren();
    const h = document.createElement('div'); h.className = 'pv-name';
    if (p.selected.size > 1) {
      // shortcut: folders in a multi-selection are counted, not totalled (Properties totals one folder); walk them if asked for.
      const sel = p.rows.filter((r) => p.selected.has(r.path)), files = sel.filter((r) => !r.dir), dirs = sel.length - files.length;
      h.textContent = `${sel.length} items selected`;
      const m = document.createElement('div'); m.className = 'pv-meta';
      m.textContent = [files.length && `${formatSize(files.reduce((n, r) => n + r.size, 0))} in ${files.length} file${files.length === 1 ? '' : 's'}`, dirs && `${dirs} folder${dirs === 1 ? '' : 's'} (contents not counted)`].filter(Boolean).join(' · ');
      head.append(h, m);
      return;
    }
    e ||= isFolder(p.path) ? { name: p.path.split(/[\\/]/).filter(Boolean).pop() || p.path, path: p.path, dir: true } : null;
    if (!e) { head.textContent = 'Nothing selected'; return; }
    h.textContent = e.name;
    head.append(h);
    this.showDetails(e, head);
    const node = await this.previewNode(e);
    if (t === this.previewSeq) box.append(node);
  },
  // What shows an item: an image, a PDF frame, text, the system's thumbnail, or a note. The preview column and quick look share it.
  async previewNode(e) {
    const ext = extOf(e.name);
    const src = () => window.__TAURI__.core.convertFileSrc(e.path);
    let node;
    if (e.dir) {
      node = ''; // a folder is all details
    } else if (IMAGES.includes(ext)) {
      node = Object.assign(document.createElement('img'), { className: 'pv-img', src: src(), alt: e.name });
      node.onerror = () => node.replaceWith(note('No preview for this image'));
    } else if (ext === 'pdf') {
      node = Object.assign(document.createElement('iframe'), { className: 'pv-pdf', src: src(), title: e.name });
    } else {
      const text = await invoke('read_text', { path: e.path }).catch(() => null);
      // Not text: what the system's own file manager shows for it (Windows: Explorer's thumbnail or icon).
      const pic = text == null && await invoke('thumb', { path: e.path, size: 256 }).catch(() => null);
      node = pic ? Object.assign(document.createElement('img'), { className: 'pv-img', src: pic, alt: e.name })
        : text == null ? note('No preview for this kind of file') : Object.assign(document.createElement('pre'), { className: 'pv-text', textContent: text });
    }
    return node;
  },
  previewSeq: 0,
  // The details block under the name: what the listing knows at once, then what `props` and the image itself add.
  async showDetails(e, head) {
    const dl = Object.assign(document.createElement('dl'), { className: 'pv-details' });
    const when = (ms) => (ms ? new Date(ms).toLocaleString() : '');
    let pr = null, dim = '';
    const fill = () => {
      dl.replaceChildren();
      const row = (k, v) => { if (v) dl.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })); };
      const size = pr?.size ?? e.size, n = pr ? pr.files + pr.folders : 0;
      row('Type', kindOf(e));
      if (!e.dir) row('Size', `${formatSize(size)}${size >= 1024 ? ` (${size.toLocaleString()} bytes)` : ''}`);
      else if (pr) row('Contains', `${n.toLocaleString()} item${n === 1 ? '' : 's'}`);
      row('Dimensions', dim);
      row('Modified', when(pr?.mtime || e.mtime)); row('Created', when(pr?.ctime));
      row('Path', e.path);
      if (pr?.mode != null) row('Permissions', formatMode(pr.mode));
      row('Owner', pr?.owner);
      if (pr?.readonly != null) row('Attributes', [pr.readonly && 'Read-only', pr.hidden && 'Hidden'].filter(Boolean).join(', ') || 'None');
    };
    fill(); head.append(dl);
    if (!e.dir && IMAGES.includes(extOf(e.name))) {
      const i = new Image();
      i.onload = () => { dim = `${i.naturalWidth} × ${i.naturalHeight} px`; fill(); };
      i.src = window.__TAURI__.core.convertFileSrc(e.path);
    }
    pr = await invoke('props', { path: e.path, deep: false }).catch(() => null); // deep false: a folder is not walked on every cursor move
    fill();
  },

  // "?" sheet: every action from keys.js, grouped, with its keys; Change rebinds, Reset goes back to the preset.
  showKeys() {
    const sheet = $('#keys');
    const draw = () => {
      const body = sheet.querySelector('.keys-body'); body.replaceChildren();
      const sel = sheet.querySelector('select'); sel.value = this.state.preset;
      let group = null;
      const btn = (text, title, run) => Object.assign(document.createElement('button'), { textContent: text, title, onclick: run });
      // After the Settings rows: the aliases, each with Go and Remove.
      const aliases = () => {
        body.append(Object.assign(document.createElement('h3'), { textContent: 'Folder aliases · type @name in the path bar' }));
        for (const [k, path] of Object.entries({ h: this.home, ...this.state.aliases })) {
          const row = document.createElement('div'); row.className = 'key-row';
          row.append(Object.assign(document.createElement('kbd'), { textContent: `@${k}` }), Object.assign(document.createElement('span'), { className: 'key-label', textContent: path }),
            btn('Go', `Open ${path}`, () => { this.hideKeys(); this.goPlace(path); }));
          if (k in this.state.aliases) row.append(btn('Remove', `Remove the alias @${k}`, () => { delete this.state.aliases[k]; this.saveState(); draw(); }));
          body.append(row);
        }
      };
      for (const a of ACTIONS) {
        if (a.group !== group) { if (group === 'Settings') { aliases(); this.actionRows(body); } group = a.group; body.append(Object.assign(document.createElement('h3'), { textContent: group })); }
        const row = document.createElement('div'); row.className = 'key-row';
        const ks = document.createElement('span'); ks.className = 'key-chips';
        for (const c of keysFor(a, this.state.preset, this.state.keys)) ks.append(Object.assign(document.createElement('kbd'), { textContent: label(c) }));
        const ch = Object.assign(document.createElement('button'), { textContent: 'Change', title: `Change the key for ${a.label}` });
        ch.onclick = () => {
          ch.textContent = 'Press a key…'; ch.classList.add('listening');
          const grab = (ev) => {
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key)) return;
            ev.preventDefault(); ev.stopPropagation(); removeEventListener('keydown', grab, true);
            if (ev.key !== 'Escape') { this.state.keys[a.id] = [comboOf(ev)]; this.rebuildKeys(); this.saveState(); }
            draw();
          };
          addEventListener('keydown', grab, true);
        };
        row.append(Object.assign(document.createElement('span'), { className: 'key-label', textContent: a.label }), ks, ch);
        // A setting's own control: On/Off for a toggle; the others leave the sheet and run.
        if (a.toggle) { const on = this.state[a.toggle], b = btn(on ? 'On' : 'Off', `${a.label}: ${on ? 'on' : 'off'}. Click to turn it ${on ? 'off' : 'on'}.`, () => { a.run(this); draw(); }); b.className = 'setting'; b.setAttribute('aria-pressed', String(on)); row.prepend(b); }
        else if (a.group === 'Settings') { const b = btn(a.label.split(' ')[0], a.label, () => { this.hideKeys(); a.run(this); }); b.className = 'setting'; row.prepend(b); }
        if (this.state.keys[a.id]) {
          const r = Object.assign(document.createElement('button'), { textContent: 'Reset', title: 'Back to the preset key' });
          r.onclick = () => { delete this.state.keys[a.id]; this.rebuildKeys(); this.saveState(); draw(); };
          row.append(r);
        }
        body.append(row);
      }
    };
    sheet.querySelector('select').onchange = (ev) => { this.state.preset = ev.target.value; this.rebuildKeys(); this.saveState(); draw(); };
    sheet.querySelector('.keys-close').onclick = () => this.hideKeys();
    draw(); sheet.hidden = false; sheet.querySelector('.keys-close').focus();
  },
  hideKeys() { $('#keys').hidden = true; this.pane().list.focus(); },
  rebuildKeys() { this.keymap = buildMap(this.state.preset in PRESETS ? this.state.preset : 'default', this.state.keys); },
};
window.folyrenFiles = app; // test hook for the engine checks

function keydown(e) {
  if (app.ops.promptKey(e)) return;
  if (!$('#keys').hidden) { if (e.key === 'Escape') { e.preventDefault(); app.hideKeys(); } return; }
  if (!$('#props').hidden) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); app.hideProps(); } return; }
  // An open overlay (bulk rename, jump, palette, quick look: extras.js) takes every key; Escape closes it.
  if (app.over) { if (e.key === 'Escape') { e.preventDefault(); app.closeOver(); } else app.over.key?.(e); return; }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.closest?.('#side-menu')) return;
  const a = lookup(app.keymap, e);
  if (a) { e.preventDefault(); a.run(app, e); return; }
  if (app.pane().key(e)) e.preventDefault();
}

function splitter() {
  const s = $('.splitter'), m = $('#panes');
  s.onpointerdown = (e) => {
    s.setPointerCapture(e.pointerId);
    const r = m.getBoundingClientRect();
    s.onpointermove = (ev) => { app.state.split = (ev.clientX - r.left) / r.width; app.layout(); };
    s.onpointerup = () => { s.onpointermove = null; app.saveState(); };
  };
  s.ondblclick = () => { app.state.split = 0.5; app.layout(); app.saveState(); };
}

async function start() {
  followDesktopTheme(() => {});
  app.panes = [...document.querySelectorAll('.pane')].map((el, i) => new Pane(el, app, i));
  // asked = the folder this window was opened for (command line, Ctrl+N, "show in folder"); select = the item to land on.
  const [places, [asked, select]] = await Promise.all([invoke('places'), invoke('startup_path')]);
  app.home = places.find((p) => p.kind === 'home')?.path || '';
  const fromArgs = asked != null, startPath = asked ?? app.home;
  app.renderPlaces(places);
  app.ops = setupOps(app);
  setupExtras(app);
  setupAddons(app);
  setupDnd(app);
  setupNet(app);
  // Opened by the file chooser portal for another app's Open / Save dialog (Linux): the pick bar, and nothing saved.
  const picking = await invoke('pick_request').catch(() => null);
  if (picking) setupPick(app, picking);
  app.rebuildKeys();
  const sel = $('#keys select');
  for (const [id, name] of Object.entries(PRESETS)) sel.append(new Option(name, id));
  $('#btn-preview').onclick = () => app.togglePreview();
  $('#btn-keys').onclick = () => app.showKeys();
  $('#btn-theme').onclick = () => openThemePicker();
  $('#preview').prepend(app.grip((w) => { app.state.pvw = Math.min(900, Math.max(200, w)); }, () => $('#preview').getBoundingClientRect().width, () => { app.state.pvw = 320; }, -1));
  $('#preview').hidden = !app.state.preview; $('#btn-preview').setAttribute('aria-pressed', String(app.state.preview));
  $('#btn-dual').onclick = () => app.toggleDual();
  $('#btn-swap').onclick = () => app.swap();
  app.layout(); splitter();
  addEventListener('keydown', keydown);
  addEventListener('blur', () => app.closeSideMenu());
  // No browser Back/Forward/Reload menu anywhere; text fields keep theirs for cut and paste.
  addEventListener('contextmenu', (e) => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); });
  // Several windows share the one saved state: take over what another window just saved (pins, aliases, keys, recents …),
  // so this window's next save does not put its older copy back over it. Tabs stay the main window's own.
  addEventListener('storage', (e) => {
    if (e.key !== STORE || !e.newValue) return;
    let s; try { s = JSON.parse(e.newValue); } catch { return; }
    const drawn = () => JSON.stringify([app.state.pins, app.state.side, app.state.keys, app.state.preset]), was = drawn();
    for (const k of [...SHARED, ...(app.guest ? ['paths', 'tabs', 'focus'] : [])]) if (k in s) app.state[k] = s[k];
    if (drawn() !== was) { app.rebuildKeys(); app.renderPlaces(); app.panes.forEach((p) => p.renderTabs()); }
  });
  addEventListener('focus', () => invoke('places').then((p) => app.renderPlaces(p)).catch(() => {})); // a drive may have come back
  // A folder the window was opened for wins over the remembered left pane.
  // Settings: "Reopen tabs from last time". Off = a plain start opens home in both panes; a window opened for a folder is as before.
  const restore = fromArgs || app.state.restoreTabs !== false;
  app.guest = fromArgs;
  // A list (Trash, Recent, This PC) reopens as home.
  const real = (path) => (path == null || isFolder(path) ? path : app.home);
  const [a, b] = restore ? app.state.paths.map(real) : [];
  const left = fromArgs ? startPath : (a ?? startPath);
  // A remembered tab reopens only if its folder still answers.
  const live = (path) => (path == null || !isFolder(path) ? real(path) : invoke('probe', { path }).then((k) => (k === 'dir' ? path : null), () => null));
  // Restore each pane's tabs; a command-line folder replaces the left pane's active tab.
  for (const [i, pane] of app.panes.entries()) {
    const saved = restore ? app.state.tabs[i] : null;
    if (saved?.paths?.length > 1) {
      const paths = await Promise.all(saved.paths.map(live)), idx = Math.min(saved.idx || 0, paths.length - 1);
      const kept = paths.map((path, n) => ({ path, n })).filter((t) => t.path != null);
      if (kept.length) {
        pane.tabs = kept.map(({ path }) => ({ path, back: [], fwd: [] }));
        pane.tabIdx = Math.max(0, kept.filter((t) => t.n <= idx).length - 1); // the tab that was open, or the one before it
        pane.back = pane.tabs[pane.tabIdx].back; pane.fwd = pane.tabs[pane.tabIdx].fwd;
      }
    }
    const tabPath = pane.tabs[pane.tabIdx].path;
    const want = i === 0 ? (fromArgs ? startPath : tabPath ?? left) : (tabPath ?? b ?? left);
    if (!(await pane.go(want, { push: false, keep: i === 0 ? select : null }))) await pane.go(app.home, { push: false });
  }
  app.focus(fromArgs ? 0 : Math.min(app.state.focus, app.state.dual ? 1 : 0));
  app.pick?.focus();
}

start();
