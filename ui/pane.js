// One file pane: path bar, sortable list, its own history and cursor.
import { sortEntries, formatSize, formatDate, kindOf, crumbs, resolveTyped, expandAlias, relFolder, TRASH, RECENT, TAGS, placeName, isFolder, WIN, visited } from './util.js';
import { extOf, formatMode, formatCount, IMAGES, COLUMNS, shownCols, viewOf, remember, gridStep, isAddress } from './util.js';
import { icon, iconFor } from './icons.js';
import { ACTIONS, keysFor, label, lookup } from './keys.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const tabName = (p) => placeName(p || '') ?? (p.split(/[\\/]/).filter(Boolean).pop() || p);
const COLS = [['name', 'Name'], ...Object.entries(COLUMNS).map(([k, c]) => [k, c[1]])];
const CELL = { size: (e) => (e.dir ? formatCount(e.items) : formatSize(e.size)), date: (e) => formatDate(e.mtime), kind: kindOf, created: (e) => formatDate(e.ctime), mode: (e) => (e.mode == null ? '' : formatMode(e.mode)) };
const TILE = [84, 124, 188]; // grid tile widths in px: small, medium, large

export class Pane {
  constructor(root, app, side) {
    this.root = root; this.app = app; this.side = side;
    this.path = null; this.parent = null; this.entries = []; this.rows = [];
    this.back = []; this.fwd = []; this.cursor = 0;
    // Each tab owns its folder and history; this.back/this.fwd point at the active tab's arrays.
    this.tabs = [{ path: null, back: this.back, fwd: this.fwd }]; this.tabIdx = 0; this.closed = []; this.selected = new Set(); this.anchor = 0;
    // Search: query filters this folder at once, then `found` holds the subfolder hits once they arrive.
    this.query = ''; this.found = null; this.searching = false;
    this.filter = ''; this.total = 0; // "/" filter: lower-case text the shown names must hold; total = rows before it
    this.build();
  }

  build() {
    this.tabBar = el('div', 'tabs'); this.tabBar.setAttribute('role', 'tablist');
    const bar = el('div', 'bar');
    const nav = (label, glyph, fn) => { const b = el('button', 'nav', glyph); b.title = label; b.setAttribute('aria-label', label); b.onclick = () => { fn(); this.app.focus(this.side); }; return b; };
    this.btnBack = nav('Back (Alt+Left)', '‹', () => this.goBack());
    this.btnFwd = nav('Forward (Alt+Right)', '›', () => this.goForward());
    this.btnUp = nav('Up (Alt+Up)', '⌃', () => this.up());
    this.crumbBox = el('div', 'crumbs');
    this.crumbBox.onclick = (e) => { if (e.target === this.crumbBox) this.editPath(); };
    // A long path keeps its end (the current folder) in view when the pane narrows.
    new ResizeObserver(() => { this.crumbBox.scrollLeft = this.crumbBox.scrollWidth; }).observe(this.crumbBox);
    this.input = el('input', 'path-input'); this.input.hidden = true; this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Folder path');
    this.input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.commitPath(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closePath(); }
      e.stopPropagation();
    };
    this.input.onblur = () => this.closePath();
    // Typing "@" names the aliases that fit, in the status bar (the Settings ? sheet lists them all).
    this.input.oninput = () => { const v = this.input.value.trim(); if (!this.aliasing && /^@[^\\/]*$/.test(v)) this.app.flash(this.app.aliasHint(v.slice(1))); };
    // Which side this is; clicking it takes control of this pane.
    this.tag = el('button', 'side-tag', this.side ? 'R' : 'L');
    this.tag.title = `${this.side ? 'Right' : 'Left'} pane (Ctrl+${this.side ? 'Right' : 'Left'}; Tab switches)`;
    this.tag.setAttribute('aria-label', this.tag.title);
    this.tag.onclick = () => this.app.focus(this.side);
    this.find = el('input', 'path-input search-input'); this.find.hidden = true; this.find.spellcheck = false;
    this.find.setAttribute('aria-label', 'Search');
    this.find.oninput = () => this.setQuery(this.find.value);
    this.find.onkeydown = (e) => {
      const a = lookup(this.app.keymap, e);
      if (e.key === 'Escape') { e.preventDefault(); this.closeSearch(); }
      else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); this.list.focus(); }
      else if (a?.id === 'searchText' || a?.id === 'searchCase') { e.preventDefault(); a.run(this.app); } // the two search switches work while typing
      e.stopPropagation();
    };
    this.find.onblur = (e) => { if (!this.find.value.trim() && !this.findOpts.contains(e.relatedTarget)) this.closeSearch(false); };
    // Beside the search box: Contents = look inside the files instead of at their names; Match case goes with it.
    this.inText = false;
    this.btnText = el('button', 'find-opt', 'Contents'); this.btnText.setAttribute('aria-pressed', 'false');
    this.btnText.title = 'Search inside files instead of in their names (Ctrl+Alt+F)';
    this.btnText.onclick = () => this.searchText();
    this.caseBox = el('input'); this.caseBox.type = 'checkbox'; this.caseBox.onchange = () => this.setQuery(this.find.value);
    this.caseTick = el('label', 'find-opt'); this.caseTick.append(this.caseBox, 'Match case'); this.caseTick.hidden = true;
    this.caseTick.title = 'Contents search: capital and small letters must match';
    this.findOpts = el('span', 'find-opts'); this.findOpts.hidden = true; this.findOpts.append(this.btnText, this.caseTick);
    this.findOpts.onmousedown = (e) => { if (e.target !== this.caseBox) e.preventDefault(); }; // the search box keeps focus under a click here
    this.btnFind = el('button', 'nav'); this.btnFind.append(icon('search'));
    this.btnFind.title = 'Search this folder and its subfolders (Ctrl+F)'; this.btnFind.setAttribute('aria-label', 'Search');
    this.btnFind.onclick = () => (this.find.hidden ? this.openSearch() : this.closeSearch());
    this.btnPin = nav('Pin this folder to the sidebar (Ctrl+D)', '☆', () => this.app.togglePin(this.path));
    // Not nav(): that hands focus back to the list, which would close the name box at once.
    this.btnAlias = el('button', 'nav', '@'); this.btnAlias.title = 'Alias this folder… (Ctrl+Shift+A): name it, then type @name in the path bar to come back';
    this.btnAlias.setAttribute('aria-label', 'Alias this folder'); this.btnAlias.onclick = () => this.askAlias();
    // "/" filter: hides the rows whose name does not hold the typed text, as you type. Enter keeps it, Esc clears it.
    this.filt = el('input', 'path-input filter-input'); this.filt.hidden = true; this.filt.spellcheck = false;
    this.filt.placeholder = 'Filter names'; this.filt.setAttribute('aria-label', 'Filter this list by name');
    this.filt.oninput = () => this.setFilter(this.filt.value);
    this.filt.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeFilter(); }
      else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); this.list.focus(); }
      e.stopPropagation();
    };
    this.filt.onblur = () => { if (!this.filter) this.filt.hidden = true; };
    this.btnFilter = el('button', 'nav'); this.btnFilter.append(icon('filter'));
    this.btnFilter.title = 'Filter this list by name as you type (/); click again or Esc to clear'; this.btnFilter.setAttribute('aria-label', 'Filter this list by name');
    this.btnFilter.onmousedown = (e) => e.preventDefault(); // the box keeps focus, so its blur cannot close it under the click
    this.btnFilter.onclick = () => (this.filt.hidden ? this.openFilter() : this.closeFilter());
    // Grid or list at a click; the menu beside it holds the rest of the view: tile size, sort, columns.
    this.btnGrid = nav('Grid or list view (Ctrl+G)', '▦', () => this.setView({ grid: !this.grid }));
    this.btnView = el('button', 'nav', '☰'); this.btnView.title = 'View menu: tile size, sort, columns (Alt+V)';
    this.btnView.setAttribute('aria-label', 'View menu'); this.btnView.setAttribute('aria-haspopup', 'menu'); this.btnView.onclick = () => this.viewMenu();
    bar.append(this.tag, this.btnBack, this.btnFwd, this.btnUp, this.crumbBox, this.input, this.find, this.findOpts, this.filt, this.btnFind, this.btnFilter, this.btnGrid, this.btnView, this.btnAlias, this.btnPin);

    const head = this.head = el('div', 'head row');
    head.oncontextmenu = (ev) => { ev.preventDefault(); this.app.focus(this.side); this.viewMenu({ left: ev.clientX, top: ev.clientY, bottom: ev.clientY }); };
    this.heads = {};
    for (const [k, label] of COLS) {
      const h = el('button', `c-${k}`, label);
      h.onclick = () => { this.app.setSort(k); };
      h.append(this.app.grip((w) => { this.app.state.cols[k] = Math.max(50, w); }, () => h.getBoundingClientRect().width, () => { delete this.app.state.cols[k]; }));
      this.heads[k] = h; head.append(h);
    }
    this.list = el('div', 'list'); this.list.tabIndex = 0;
    this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-multiselectable', 'true');
    this.list.onfocus = () => this.app.focus(this.side, true);
    this.list.oncontextmenu = (ev) => { ev.preventDefault(); this.app.focus(this.side); this.app.entryMenu(ev, null); };
    // Ctrl+wheel steps the grid's tile size (one step per 200 ms: a touchpad sends a stream of these).
    this.list.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !this.grid) return;
      e.preventDefault();
      if (e.timeStamp - (this.zoomed || 0) > 200) { this.zoomed = e.timeStamp; this.setTile(e.deltaY < 0 ? 1 : -1); }
    }, { passive: false });
    // Grid pictures: loaded once a tile has stayed in view a moment, let go again when it scrolls well away,
    // so a folder of thousands only ever holds a few screens of them.
    this.io = new IntersectionObserver((es) => {
      for (const { target: pic, isIntersecting } of es) {
        clearTimeout(pic.wait);
        if (isIntersecting) { if (!pic.on) pic.wait = setTimeout(() => this.loadPic(pic), 60); }
        else if (pic.on) { pic.on = false; pic.replaceChildren(pic.ico); }
      }
    }, { root: this.list, rootMargin: '400px 0px' });
    this.empty = el('div', 'empty'); this.empty.hidden = true;
    this.root.append(this.tabBar, bar, head, this.list, this.empty);
    this.root.addEventListener('mousedown', () => this.app.focus(this.side, true));
  }

  async go(path, { push = true, keep } = {}) {
    if (isAddress(path)) return this.app.net.open(path, this); // a server, phone or locked drive: mounted first, then opened (net.js)
    let listing;
    try { listing = await invoke('list_dir', { path }); }
    catch (err) { this.app.flash(String(err)); return false; }
    if (push && this.path != null && this.path !== listing.path) { this.back.push(this.path); this.fwd.length = 0; }
    const from = this.path;
    this.resetSearch();
    if (listing.path !== from) this.resetFilter(); // another folder opens unfiltered; a refresh keeps the filter
    this.path = listing.path; this.parent = listing.parent; this.entries = listing.entries;
    this.tabs[this.tabIdx].path = this.path;
    this.selected.clear();
    this.render(keep ?? (from && listing.entries.some((e) => e.path === from) ? from : null));
    this.app.loadTags?.(this.path); // not awaited: the tag dots follow if the tags changed
    this.renderTabs();
    if (isFolder(this.path)) this.app.state.recents = visited(this.app.state.recents, this.path); // for the ":" jump box
    this.app.saveState();
    return true;
  }

  refresh() { if (this.query) return this.runSearch(); if (this.path != null) return this.go(this.path, { push: false, keep: this.rows[this.cursor]?.path }); }
  goBack() { if (this.back.length) { const p = this.back.pop(); this.fwd.push(this.path); this.go(p, { push: false }); } }
  goForward() { if (this.fwd.length) { const p = this.fwd.pop(); this.back.push(this.path); this.go(p, { push: false }); } }
  up() { if (this.parent != null) this.go(this.parent); }

  render(keepPath) {
    const state = this.app.state, { hidden } = state, list = this.path === TRASH || this.path === RECENT || !!this.path?.startsWith(TAGS), tags = this.app.tags || {};
    Object.assign(this, viewOf(state, this.side, this.path)); // this.grid, this.tile, this.sort
    const cols = this.grid ? [] : shownCols(state);
    this.head.hidden = this.grid; this.list.classList.toggle('grid', this.grid);
    this.list.style.setProperty('--tile', `${TILE[this.tile] ?? TILE[1]}px`);
    this.btnGrid.setAttribute('aria-pressed', String(this.grid));
    this.io.disconnect();
    // Recent is a history: always newest first, whatever folders are sorted by.
    const sort = this.path === RECENT ? { key: 'date', reverse: true } : this.sort;
    this.heads.date.firstChild.data = this.path === TRASH ? 'Deleted' : 'Modified';
    const q = this.query.toLowerCase();
    const src = !q ? this.entries : this.found ?? (this.inText ? [] : this.entries.filter((e) => e.name.toLowerCase().includes(q)));
    if (this.counted !== hidden) { this.counted = hidden; for (const e of src) delete e.items; } // the counts follow the hidden setting
    // A file chooser (pick.js) also hides the files its file-type filter leaves out.
    const shown = (hidden ? src : src.filter((e) => !e.hidden)).filter(this.app.pick?.shows ?? Boolean), f = this.filter;
    this.total = shown.length;
    this.rows = sortEntries(f ? shown.filter((e) => e.name.toLowerCase().includes(f)) : shown, sort.key, sort.reverse, state);
    // What the filter hides leaves the selection too, so no command can act on a row that is not shown.
    if (f) this.selected = new Set(this.rows.filter((e) => this.selected.has(e.path)).map((e) => e.path));
    for (const [k, h] of Object.entries(this.heads)) {
      h.hidden = k !== 'name' && !cols.includes(k);
      h.classList.toggle('sorted', sort.key === k);
      h.dataset.dir = sort.key === k ? (sort.reverse ? 'desc' : 'asc') : '';
    }
    // shortcut: renders every row; add windowing if folders of 20k+ entries feel slow.
    const frag = document.createDocumentFragment();
    this.rows.forEach((e, i) => {
      const r = el('div', `${this.grid ? 'tile' : 'row'} item${e.dir ? ' dir' : ''}${e.hidden ? ' hidden-file' : ''}${e.link ? ' link' : ''}`);
      r.setAttribute('role', 'option'); r.dataset.i = i;
      const name = el('span', 'c-name'), ico = icon(iconFor(e.name, e.dir));
      // A tile: the picture (the type icon until a thumbnail loads, see loadPic) above the name.
      if (this.grid) { const pic = el('span', 'pic'); pic.ico = ico; pic.append(ico); r.append(pic); r.title = e.name; if (!e.dir && !e.noPic) this.io.observe(pic); } else name.append(ico);
      name.append(el('span', 'nm', e.name));
      if (tags[e.path]) { const d = el('span', 'tag-dot'); d.style.background = `var(--tag-${tags[e.path]})`; d.title = `Tagged ${tags[e.path]}`; d.setAttribute('role', 'img'); d.setAttribute('aria-label', d.title); name.append(d); }
      // Trash and Recent show the folder each item came from / lives in.
      const where = list ? (e.origin || e.path).replace(/[\\/][^\\/]*$/, '') || '/' : q && relFolder(this.path, e.path);
      if (where) { const w = el('span', 'where', where); w.title = e.path; name.append(w); }
      // A contents-search hit: how many matches and the first matching line.
      if (e.note && q) { const w = el('span', 'where hit', e.note); w.title = e.note; name.append(w); if (this.grid) r.title = `${e.name}\n${e.note}`; }
      r.append(name, ...cols.map((k) => el('span', `c-${k}`, CELL[k](e))));
      // A plain press on a row of a multi-selection keeps it (a drag may start here, see dnd.js); the click after narrows it.
      const plain = (ev) => this.selected.size > 1 && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey;
      r.onmousedown = (ev) => { if (ev.button !== 0) return; if (plain(ev) && this.selected.has(e.path)) { this.cursor = i; this.paintCursor(false); } else this.click(i, ev); };
      r.onclick = (ev) => { if (plain(ev)) this.click(i, ev); };
      r.draggable = !WIN && this.path !== TRASH; // Windows drags with pointer events instead
      r.ondblclick = () => this.activate(i);
      r.oncontextmenu = (ev) => {
        ev.preventDefault(); ev.stopPropagation(); // right-click acts on the selection when the row is in it, like Explorer
        if (this.selected.has(e.path)) { this.cursor = i; this.paintCursor(false); } else this.click(i, {});
        this.app.focus(this.side); this.app.entryMenu(ev, e);
      };
      frag.append(r);
    });
    this.list.replaceChildren(frag);
    this.empty.hidden = this.rows.length > 0;
    this.empty.textContent = q ? (this.inText ? (this.searching ? 'Searching inside the files here and in subfolders…' : `No file here or in subfolders contains "${this.query}"`) : this.searching ? 'Searching subfolders…' : `Nothing named like "${this.query}" here or in subfolders`) : this.entries.length ? 'Only hidden items here (Ctrl+H shows them)' : placeName(this.path) ? `${placeName(this.path)} is empty` : 'This folder is empty';
    if (f && this.total) this.empty.textContent = `No name here holds "${this.filt.value}" (Esc clears the filter)`;
    const k = keepPath ? this.rows.findIndex((e) => e.path === keepPath) : -1;
    this.cursor = Math.max(0, Math.min(k >= 0 ? k : this.cursor, this.rows.length - 1));
    if (!keepPath && this.cursor >= this.rows.length) this.cursor = 0;
    this.anchor = this.cursor;
    this.renderCrumbs();
    this.paintCursor(true);
    this.btnBack.disabled = !this.back.length; this.btnFwd.disabled = !this.fwd.length; this.btnUp.disabled = this.parent == null;
    if (cols.includes('size')) this.count();
  }

  // Folder rows get their item count after the list is drawn, all in one call, so a big folder opens at once.
  count() {
    const need = isFolder(this.path) ? this.rows.filter((e) => e.dir && e.items === undefined) : [], { hidden } = this.app.state;
    if (!need.length) return;
    for (const e of need) e.items = null; // asked for: a redraw meanwhile does not ask again
    invoke('dir_counts', { paths: need.map((e) => e.path), hidden }).then((ns) => {
      if (hidden !== this.app.state.hidden) return; // hidden items were switched meanwhile: that draw asked again
      need.forEach((e, i) => { e.items = ns[i] ?? null; });
      const got = new Set(need);
      this.rows.forEach((e, i) => { const c = got.has(e) && this.list.children[i]?.querySelector('.c-size'); if (c) c.textContent = formatCount(e.items); });
    }).catch(() => {});
  }

  // A tile's picture: an image file itself, else what `thumb` has (Windows: Explorer's thumbnail or icon; Linux: the desktop's cached thumbnail).
  // shortcut: an image tile decodes the whole file, as the preview column does; make real thumbnails if folders of large photos scroll slowly.
  async loadPic(pic) {
    const e = this.rows[pic.parentElement?.dataset.i];
    if (!e || !pic.isConnected) return;
    pic.on = true;
    const size = Math.round((TILE[this.tile] ?? TILE[1]) * (devicePixelRatio || 1));
    const src = IMAGES.includes(extOf(e.name)) ? window.__TAURI__.core.convertFileSrc(e.path) : await invoke('thumb', { path: e.path, size }).catch(() => null);
    if (!src) e.noPic = true; // nothing to show for it: not asked again
    if (!src || !pic.on || !pic.isConnected) return;
    const img = Object.assign(new Image(), { alt: '', draggable: false });
    img.onload = () => { if (pic.on && pic.isConnected) pic.replaceChildren(img); };
    img.src = src;
  }

  // Changes this folder's view ({ grid, tile, sort }). With "Remember view per folder" on it is kept for this
  // folder only; otherwise (and in the lists: Trash, Recent, This PC) it becomes the pane's default.
  setView(v) {
    const s = this.app.state, now = { grid: this.grid, tile: this.tile, sort: this.sort, ...v };
    if (s.perFolder && isFolder(this.path)) s.folders = remember(s.folders, this.path, { grid: now.grid, tile: now.tile, key: now.sort.key, reverse: now.sort.reverse });
    else { s.view[this.side] = { grid: now.grid, tile: now.tile }; s.sort = now.sort; }
    this.app.redraw();
  }
  setTile(d) {
    const t = Math.max(0, Math.min(2, this.tile + d));
    if (!this.grid) return this.app.flash('Tile size is for the grid view (Ctrl+G switches to it)');
    if (t === this.tile) return this.app.flash(d > 0 ? 'That is the largest tile size' : 'That is the smallest tile size');
    this.setView({ tile: t });
  }
  // "Use this view for other folders": folders with no view of their own open like this one from now on.
  makeDefault() {
    const s = this.app.state;
    s.view[this.side] = { grid: this.grid, tile: this.tile }; s.sort = this.sort;
    this.app.redraw(); this.app.flash('Folders with no view of their own now open like this one');
  }
  // The view menu (☰ in the bar, Alt+V, right-click on the column header). Every item is a command from keys.js.
  viewMenu(r = this.btnView.getBoundingClientRect()) {
    const a = this.app, s = a.state, shown = shownCols(s);
    const it = (id, text, on, off) => { const x = ACTIONS.find((q) => q.id === id), c = keysFor(x, s.preset, s.keys)[0]; return [`${on ? '✓' : '\u2003'} ${text}`, () => { a.closeSideMenu(); this.list.focus(); x.run(a, {}); }, off, c ? label(c) : '']; };
    const by = (k, id, name) => (k === 'name' || shown.includes(k)) && it(id, `Sort by ${name}${this.sort.key === k ? (this.sort.reverse ? ' ▾' : ' ▴') : ''}`, this.sort.key === k);
    a.popMenu(r, [
      it('gridView', 'Grid view', this.grid), it('tileBigger', 'Larger tiles', false, !this.grid || this.tile >= 2), it('tileSmaller', 'Smaller tiles', false, !this.grid || this.tile <= 0), null,
      by('name', 'sortName', 'name'), by('size', 'sortSize', 'size'), by('date', 'sortDate', 'date modified'), by('kind', 'sortKind', 'type'), by('created', 'sortCreated', 'date created'), by('mode', 'sortMode', 'permissions'), null,
      it('dirsFirst', 'Folders first', s.dirsFirst), it('natural', 'Number order (file2 before file10)', s.natural), it('hiddenLast', 'Hidden items last', s.hiddenLast), null,
      ...Object.entries(COLUMNS).filter(([k]) => !(WIN && k === 'mode')).map(([, [key, name]]) => it(key, `Column: ${name}`, s[key])), null,
      it('perFolder', 'Remember view per folder', s.perFolder), it('viewDefault', 'Use this view for other folders', false, !s.perFolder),
    ], this.list);
  }

  // Tabs: strip above the path bar; + adds one, × or middle-click closes.
  renderTabs() {
    const kids = this.tabs.map((t, i) => {
      const b = el('div', `tab${i === this.tabIdx ? ' on' : ''}`); b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === this.tabIdx)); b.dataset.drop = t.path ?? ''; b.title = placeName(t.path || '') ?? t.path;
      b.append(el('span', 'tab-name', tabName(t.path)));
      if (this.tabs.length > 1) { const x = el('button', 'tab-x', '×'); x.title = 'Close tab (Ctrl+W)'; x.setAttribute('aria-label', 'Close tab'); x.onmousedown = (ev) => ev.stopPropagation(); x.onclick = () => this.closeTab(i); b.append(x); }
      b.onmousedown = (ev) => { if (ev.button === 1) { ev.preventDefault(); this.closeTab(i); } else if (ev.button === 0) this.switchTab(i); };
      return b;
    });
    const add = el('button', 'tab-add', '+'); add.title = 'New tab (Ctrl+T)'; add.setAttribute('aria-label', 'New tab');
    add.onclick = () => this.newTab();
    this.tabBar.replaceChildren(...kids, add);
    const pinned = this.app.state.pins.includes(this.path);
    this.btnPin.textContent = pinned ? '★' : '☆'; this.btnPin.classList.toggle('pinned', pinned);
    this.btnPin.title = `${pinned ? 'Unpin this folder from' : 'Pin this folder to'} the sidebar (Ctrl+D)`;
  }

  switchTab(i) {
    if (i < 0 || i >= this.tabs.length) return;
    const t = this.tabs[i];
    this.tabIdx = i; this.back = t.back; this.fwd = t.fwd;
    if (t.path === this.path) { this.renderTabs(); this.render(this.rows[this.cursor]?.path); this.app.saveState(); }
    else this.go(t.path, { push: false });
    this.app.focus(this.side);
  }
  newTab(path = this.path) { this.tabs.splice(this.tabIdx + 1, 0, { path, back: [], fwd: [] }); this.path = null; this.switchTab(this.tabIdx + 1); }
  closeTab(i = this.tabIdx) {
    if (this.tabs.length < 2) return this.app.flash('That is the last tab in this pane');
    this.closed.push(this.tabs.splice(i, 1)[0]); if (this.closed.length > 20) this.closed.shift();
    const next = Math.min(i <= this.tabIdx ? Math.max(0, this.tabIdx - (i < this.tabIdx || i === this.tabs.length ? 1 : 0)) : this.tabIdx, this.tabs.length - 1);
    this.path = null; this.switchTab(next);
  }
  reopenTab() {
    const t = this.closed.pop();
    if (!t) return this.app.flash('No closed tabs to reopen');
    this.tabs.splice(this.tabIdx + 1, 0, t); this.path = null; this.switchTab(this.tabIdx + 1);
  }
  cycleTab(d) { if (this.tabs.length > 1) { this.path = null; this.switchTab((this.tabIdx + d + this.tabs.length) % this.tabs.length); } }

  toggleSelect() { const p = this.rows[this.cursor]?.path; if (p) { this.selected.has(p) ? this.selected.delete(p) : this.selected.add(p); this.paintCursor(false); } }
  selectAll() { this.selected = new Set(this.rows.map((r) => r.path)); this.paintCursor(false); }

  renderCrumbs() {
    const parts = crumbs(this.path);
    this.crumbBox.replaceChildren(...parts.flatMap((c, i) => {
      const b = el('button', 'crumb', c.name); b.onclick = () => this.go(c.path);
      if (!i) return [b];
      const s = el('button', 'sep', '›'); s.title = `Folders in ${parts[i - 1].name}`;
      s.setAttribute('aria-label', s.title); s.setAttribute('aria-haspopup', 'menu'); s.onclick = () => this.crumbMenu(i);
      return [s, b];
    }));
    this.crumbBox.title = placeName(this.path || '') ?? this.path;
    this.crumbBox.scrollLeft = this.crumbBox.scrollWidth;
  }

  // The chevron before breadcrumb part i lists the folders in the part before it; picking one goes there.
  // Alt+Down opens the last one; in the list, Left/Right step to the next chevron.
  async crumbMenu(i = crumbs(this.path).length - 1) {
    const parts = crumbs(this.path), s = this.crumbBox.querySelectorAll('.sep')[i - 1];
    if (!s || this.crumbBox.hidden) return this.app.flash('No parent folder to list here');
    let l;
    try { l = await invoke('list_dir', { path: parts[i - 1].path }); } catch (err) { return this.app.flash(String(err)); }
    if (!s.isConnected) return; // the pane went somewhere else meanwhile
    const dirs = sortEntries(l.entries.filter((e) => e.dir && (this.app.state.hidden || !e.hidden)));
    if (!dirs.length) return this.app.flash(`No folders in ${parts[i - 1].name}`);
    this.app.popMenu(s.getBoundingClientRect(), dirs.map((e) => [e.name, () => { this.app.closeSideMenu(); this.list.focus(); this.go(e.path); }, false, e.path === parts[i].path ? 'here' : '']), this.list);
    document.getElementById('side-menu').addEventListener('keydown', (e) => {
      const j = i + (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
      if (j !== i && j > 0 && parts[j]) { e.preventDefault(); this.crumbMenu(j); }
    });
  }

  paintCursor(scroll) {
    const kids = this.list.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('cursor', i === this.cursor);
      const sel = this.selected.has(this.rows[i].path);
      kids[i].classList.toggle('selected', sel);
      kids[i].setAttribute('aria-selected', sel || i === this.cursor ? 'true' : 'false');
    }
    if (scroll) kids[this.cursor]?.scrollIntoView({ block: 'nearest' });
    this.app.status();
  }

  click(i, ev) {
    const p = this.rows[i].path;
    if (ev.shiftKey) this.selectRange(this.anchor, i, ev.ctrlKey);
    else if (ev.ctrlKey || ev.metaKey) { this.selected.has(p) ? this.selected.delete(p) : this.selected.add(p); this.anchor = i; }
    else { this.selected = new Set([p]); this.anchor = i; }
    this.cursor = i; this.paintCursor(false);
  }

  selectRange(a, b, add) {
    if (!add) this.selected.clear();
    for (let j = Math.min(a, b); j <= Math.max(a, b); j++) this.selected.add(this.rows[j].path);
  }

  move(to, extend) {
    if (!this.rows.length) return;
    this.cursor = Math.max(0, Math.min(to, this.rows.length - 1));
    if (extend) this.selectRange(this.anchor, this.cursor, false);
    else { this.anchor = this.cursor; this.selected.clear(); }
    this.paintCursor(true);
  }

  pageSize() { const r = this.list.firstElementChild; return r ? Math.max(1, Math.floor(this.list.clientHeight / r.offsetHeight) - 1) * this.across() : 10; }
  // Tiles to a row in the grid (1 in the list), read from the layout when a key needs it.
  across() { return this.grid ? getComputedStyle(this.list).gridTemplateColumns.split(' ').length : 1; }
  // Arrow keys: a row up or down (dy), or one tile sideways in the grid (dx).
  step(dx, dy, extend) { if (dx && !this.grid) return; this.move(gridStep(this.cursor, this.rows.length, this.across(), dx, dy), extend); }

  activate(i = this.cursor) {
    const e = this.rows[i];
    if (!e) return;
    if (this.path === TRASH) return this.app.flash(`Restore "${e.name}" to open it: right-click it, or Alt+R`);
    const open = () => invoke('open_path', { path: e.path }).catch((err) => this.app.flash(String(err)));
    if (this.app.pick && !e.dir) return this.app.pick.activate(e); // a file chooser answers with the file instead of opening it
    if (e.dir) this.go(e.path);
    // A Windows shortcut to a folder opens that folder here, not in Explorer.
    else if (WIN && /\.lnk$/i.test(e.name)) invoke('link_dir', { path: e.path }).then((dir) => (dir ? this.go(dir) : open()), open);
    else open();
  }

  editPath() {
    this.input.value = this.path; this.crumbBox.hidden = true; this.input.hidden = false;
    this.input.focus(); this.input.select();
  }
  // "Alias this folder…": the path box doubles as the inline name box.
  askAlias() {
    if (!isFolder(this.path)) return this.app.flash('Open a folder to give it an alias');
    const a = this.app.state.aliases;
    this.editPath(); this.aliasing = true;
    this.input.value = Object.keys(a).find((k) => a[k] === this.path) || '';
    this.input.placeholder = 'Alias name for this folder · Enter saves, empty removes, Esc cancels';
    this.input.setAttribute('aria-label', 'Alias name for this folder'); this.input.select();
  }
  async commitPath() {
    const v = this.input.value.trim();
    if (this.aliasing) { if (this.app.setAlias(v, this.path)) this.closePath(); return; }
    const t = v.startsWith('@') ? expandAlias(v, this.app.state.aliases, this.app.home) : resolveTyped(v, this.app.home);
    if (t == null) return this.app.flash(`No alias named ${v.split(/[\\/]/)[0]} · the Settings ? sheet lists them`);
    if (await this.go(t)) this.closePath();
  }
  closePath() {
    if (this.input.hidden) return;
    this.aliasing = false; this.input.placeholder = ''; this.input.setAttribute('aria-label', 'Folder path');
    this.input.hidden = true; this.crumbBox.hidden = false; this.list.focus();
  }

  openSearch() {
    if (!isFolder(this.path)) return this.app.flash('Open a folder to search in it');
    this.closePath();
    this.crumbBox.hidden = true; this.find.hidden = this.findOpts.hidden = false; this.setInText(this.inText); this.find.focus(); this.find.select();
  }
  // The Contents switch: names (off) or the text inside files (on). A typed query is searched again the new way.
  setInText(on) {
    const was = this.inText;
    this.inText = on; this.btnText.setAttribute('aria-pressed', String(on)); this.caseTick.hidden = !on;
    this.find.placeholder = on ? `Search inside the files of ${tabName(this.path)} and subfolders` : `Search ${tabName(this.path)} and subfolders`;
    if (this.query && was !== on) this.setQuery(this.find.value);
  }
  // Ctrl+Alt+F and the Contents button: opens the search looking inside files; with the box open it flips the switch.
  searchText() {
    const on = this.find.hidden || !this.inText;
    if (this.find.hidden) { this.openSearch(); if (this.find.hidden) return; }
    this.setInText(on); this.find.focus();
  }
  toggleCase() {
    if (this.find.hidden || !this.inText) return this.app.flash('Match case belongs to the contents search: Ctrl+Alt+F, or the Contents button in the search box');
    this.caseBox.checked = !this.caseBox.checked; this.setQuery(this.find.value);
  }
  // Drops the search without drawing; go() calls it so a new folder never opens filtered.
  resetSearch() {
    clearTimeout(this.findTimer);
    if (this.query) invoke('search', { root: '', query: '', hidden: false }).catch(() => {}); // stops a running walk (and ripgrep)
    this.query = ''; this.found = null; this.searching = false; this.find.value = ''; this.inText = false;
    this.find.hidden = this.findOpts.hidden = true; this.crumbBox.hidden = !this.input.hidden;
  }
  closeSearch(focus = true) {
    const had = this.query;
    this.resetSearch();
    if (had) this.render(this.rows[this.cursor]?.path);
    if (focus) this.list.focus();
  }
  setQuery(text) {
    this.query = text.trim(); this.found = null; this.searching = !!this.query;
    this.render();
    clearTimeout(this.findTimer);
    if (this.query) this.findTimer = setTimeout(() => this.runSearch(), 250);
  }
  async runSearch() {
    const { query, path, inText } = this, matchCase = this.caseBox.checked, hidden = this.app.state.hidden;
    this.searching = true;
    try {
      const r = await invoke(inText ? 'search_text' : 'search', inText ? { root: path, query, hidden, matchCase } : { root: path, query, hidden });
      if (query !== this.query || path !== this.path || inText !== this.inText || matchCase !== this.caseBox.checked) return; // typed on, switched, or left the folder
      if (inText) r.entries.forEach((e, i) => { const [line, n] = r.notes[i]; e.note = `${n} match${n === 1 ? '' : 'es'} · ${line}`; });
      this.found = r.entries;
      if (r.truncated) this.app.flash(inText ? `Showing the first ${r.entries.length} files that contain it (that is the limit); type more to narrow it` : `Showing the first ${r.entries.length} matches; type more to narrow it`);
    } catch (err) {
      if (String(err) !== 'superseded') this.app.flash(String(err));
      if (query !== this.query) return;
    }
    this.searching = false;
    this.render(this.rows[this.cursor]?.path);
  }

  openFilter() { this.filt.hidden = false; this.filt.focus(); this.filt.select(); }
  setFilter(text) {
    this.filter = text.toLowerCase();
    this.btnFilter.classList.toggle('pinned', !!this.filter);
    this.render(this.rows[this.cursor]?.path);
  }
  // Drops the filter without drawing (go() draws next).
  resetFilter() { this.filter = ''; this.filt.value = ''; this.filt.hidden = true; this.btnFilter.classList.remove('pinned'); }
  closeFilter() {
    const had = this.filter;
    this.resetFilter();
    if (had) this.render(this.rows[this.cursor]?.path);
    this.list.focus();
  }

  // Edits the name in place; Enter or leaving the box commits, Escape cancels (calls `cancel` if given).
  // `initial` reopens the box with what was typed, after a refused name.
  startRename(path, commit, cancel, initial) {
    const i = this.rows.findIndex((r) => r.path === path);
    const nm = this.list.children[i]?.querySelector('.nm');
    if (!nm) return;
    const e = this.rows[i], box = el('input', 'rename-input');
    box.value = initial ?? e.name; box.spellcheck = false; box.setAttribute('aria-label', 'New name');
    nm.replaceWith(box); box.focus();
    const dot = e.dir ? -1 : box.value.lastIndexOf('.');
    box.setSelectionRange(0, dot > 0 ? dot : box.value.length);
    let closed = false;
    const finish = async (ok) => {
      if (closed) return; closed = true;
      box.replaceWith(nm); this.list.focus();
      try { if (ok) await commit(box.value.trim()); else if (cancel) await cancel(); } catch (err) { this.app.flash(String(err)); }
    };
    box.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    };
    box.onblur = () => finish(true);
    box.onmousedown = (ev) => ev.stopPropagation();
  }

  // Paths the next command acts on: the selection, else the row under the cursor.
  targets() { return this.selected.size ? [...this.selected] : (this.rows[this.cursor] ? [this.rows[this.cursor].path] : []); }

  // Type-to-jump: first row starting with the typed letters. Every other key lives in keys.js.
  key(e) {
    const k = e.key;
    if (k === 'Escape' && this.filter) { this.closeFilter(); return true; }
    if (k === 'Escape' && this.query) { this.closeSearch(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k.length === 1 && k !== ' ') {
      const now = Date.now();
      this.typed = (now - (this.typedAt || 0) < 900 ? this.typed : '') + k.toLowerCase(); this.typedAt = now;
      const j = this.rows.findIndex((r) => r.name.toLowerCase().startsWith(this.typed));
      if (j >= 0) this.move(j, false);
      return true;
    }
    return false;
  }
}
