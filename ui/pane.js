// One file pane: path bar, sortable list, its own history and cursor.
import { sortEntries, formatSize, formatDate, kindOf, crumbs, resolveTyped, relFolder, TRASH, RECENT, placeName, isFolder } from './util.js';
import { icon, iconFor } from './icons.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const tabName = (p) => placeName(p || '') ?? (p.split(/[\\/]/).filter(Boolean).pop() || p);
const COLS = [['name', 'Name'], ['size', 'Size'], ['date', 'Modified'], ['kind', 'Type']];

export class Pane {
  constructor(root, app, side) {
    this.root = root; this.app = app; this.side = side;
    this.path = null; this.parent = null; this.entries = []; this.rows = [];
    this.back = []; this.fwd = []; this.cursor = 0;
    // Each tab owns its folder and history; this.back/this.fwd point at the active tab's arrays.
    this.tabs = [{ path: null, back: this.back, fwd: this.fwd }]; this.tabIdx = 0; this.closed = []; this.selected = new Set(); this.anchor = 0;
    // Search: query filters this folder at once, then `found` holds the subfolder hits once they arrive.
    this.query = ''; this.found = null; this.searching = false;
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
    // Which side this is; clicking it takes control of this pane.
    this.tag = el('button', 'side-tag', this.side ? 'R' : 'L');
    this.tag.title = `${this.side ? 'Right' : 'Left'} pane (Ctrl+${this.side ? 'Right' : 'Left'}; Tab switches)`;
    this.tag.setAttribute('aria-label', this.tag.title);
    this.tag.onclick = () => this.app.focus(this.side);
    this.find = el('input', 'path-input search-input'); this.find.hidden = true; this.find.spellcheck = false;
    this.find.setAttribute('aria-label', 'Search');
    this.find.oninput = () => this.setQuery(this.find.value);
    this.find.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeSearch(); }
      else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); this.list.focus(); }
      e.stopPropagation();
    };
    this.find.onblur = () => { if (!this.find.value.trim()) this.closeSearch(false); };
    this.btnFind = el('button', 'nav'); this.btnFind.append(icon('search'));
    this.btnFind.title = 'Search this folder and its subfolders (Ctrl+F)'; this.btnFind.setAttribute('aria-label', 'Search');
    this.btnFind.onclick = () => (this.find.hidden ? this.openSearch() : this.closeSearch());
    this.btnPin = nav('Pin this folder to the sidebar (Ctrl+D)', '☆', () => this.app.togglePin(this.path));
    bar.append(this.tag, this.btnBack, this.btnFwd, this.btnUp, this.crumbBox, this.input, this.find, this.btnFind, this.btnPin);

    const head = el('div', 'head row');
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
    this.empty = el('div', 'empty'); this.empty.hidden = true;
    this.root.append(this.tabBar, bar, head, this.list, this.empty);
    this.root.addEventListener('mousedown', () => this.app.focus(this.side, true));
  }

  async go(path, { push = true, keep } = {}) {
    let listing;
    try { listing = await invoke('list_dir', { path }); }
    catch (err) { this.app.flash(String(err)); return false; }
    if (push && this.path != null && this.path !== listing.path) { this.back.push(this.path); this.fwd.length = 0; }
    const from = this.path;
    this.resetSearch();
    this.path = listing.path; this.parent = listing.parent; this.entries = listing.entries;
    this.tabs[this.tabIdx].path = this.path;
    this.selected.clear();
    this.render(keep ?? (from && listing.entries.some((e) => e.path === from) ? from : null));
    this.renderTabs();
    this.app.saveState();
    return true;
  }

  refresh() { if (this.query) return this.runSearch(); if (this.path != null) return this.go(this.path, { push: false, keep: this.rows[this.cursor]?.path }); }
  goBack() { if (this.back.length) { const p = this.back.pop(); this.fwd.push(this.path); this.go(p, { push: false }); } }
  goForward() { if (this.fwd.length) { const p = this.fwd.pop(); this.back.push(this.path); this.go(p, { push: false }); } }
  up() { if (this.parent != null) this.go(this.parent); }

  render(keepPath) {
    const { hidden } = this.app.state, list = this.path === TRASH || this.path === RECENT;
    // Recent is a history: always newest first, whatever folders are sorted by.
    const sort = this.path === RECENT ? { key: 'date', reverse: true } : this.app.state.sort;
    this.heads.date.firstChild.data = this.path === TRASH ? 'Deleted' : 'Modified';
    const q = this.query.toLowerCase();
    const src = !q ? this.entries : this.found ?? this.entries.filter((e) => e.name.toLowerCase().includes(q));
    this.rows = sortEntries(hidden ? src : src.filter((e) => !e.hidden), sort.key, sort.reverse);
    for (const [k, h] of Object.entries(this.heads)) {
      h.classList.toggle('sorted', sort.key === k);
      h.dataset.dir = sort.key === k ? (sort.reverse ? 'desc' : 'asc') : '';
    }
    // shortcut: renders every row; add windowing if folders of 20k+ entries feel slow.
    const frag = document.createDocumentFragment();
    this.rows.forEach((e, i) => {
      const r = el('div', `row item${e.dir ? ' dir' : ''}${e.hidden ? ' hidden-file' : ''}${e.link ? ' link' : ''}`);
      r.setAttribute('role', 'option'); r.dataset.i = i;
      const name = el('span', 'c-name'); name.append(icon(iconFor(e.name, e.dir)), el('span', 'nm', e.name));
      // Trash and Recent show the folder each item came from / lives in.
      const where = list ? (e.origin || e.path).replace(/[\\/][^\\/]*$/, '') || '/' : q && relFolder(this.path, e.path);
      if (where) { const w = el('span', 'where', where); w.title = e.path; name.append(w); }
      r.append(name, el('span', 'c-size', formatSize(e.size, e.dir)), el('span', 'c-date', formatDate(e.mtime)), el('span', 'c-kind', kindOf(e)));
      r.onmousedown = (ev) => { if (ev.button === 0) this.click(i, ev); };
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
    this.empty.textContent = q ? (this.searching ? 'Searching subfolders…' : `Nothing named like "${this.query}" here or in subfolders`) : this.entries.length ? 'Only hidden items here (Ctrl+H shows them)' : placeName(this.path) ? `${placeName(this.path)} is empty` : 'This folder is empty';
    const k = keepPath ? this.rows.findIndex((e) => e.path === keepPath) : -1;
    this.cursor = Math.max(0, Math.min(k >= 0 ? k : this.cursor, this.rows.length - 1));
    if (!keepPath && this.cursor >= this.rows.length) this.cursor = 0;
    this.anchor = this.cursor;
    this.renderCrumbs();
    this.paintCursor(true);
    this.btnBack.disabled = !this.back.length; this.btnFwd.disabled = !this.fwd.length; this.btnUp.disabled = this.parent == null;
  }

  // Tabs: strip above the path bar; + adds one, × or middle-click closes.
  renderTabs() {
    const kids = this.tabs.map((t, i) => {
      const b = el('div', `tab${i === this.tabIdx ? ' on' : ''}`); b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === this.tabIdx)); b.title = placeName(t.path || '') ?? t.path;
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
      return i ? [el('span', 'sep', '›'), b] : [b];
    }));
    this.crumbBox.title = placeName(this.path || '') ?? this.path;
    this.crumbBox.scrollLeft = this.crumbBox.scrollWidth;
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

  pageSize() { const r = this.list.firstElementChild; return r ? Math.max(1, Math.floor(this.list.clientHeight / r.offsetHeight) - 1) : 10; }

  activate(i = this.cursor) {
    const e = this.rows[i];
    if (!e) return;
    if (this.path === TRASH) return this.app.flash(`Restore "${e.name}" to open it: right-click it, or Alt+R`);
    if (e.dir) this.go(e.path);
    else invoke('open_path', { path: e.path }).catch((err) => this.app.flash(String(err)));
  }

  editPath() {
    this.input.value = this.path; this.crumbBox.hidden = true; this.input.hidden = false;
    this.input.focus(); this.input.select();
  }
  async commitPath() {
    const t = resolveTyped(this.input.value, this.app.home);
    if (await this.go(t)) this.closePath();
  }
  closePath() { if (this.input.hidden) return; this.input.hidden = true; this.crumbBox.hidden = false; this.list.focus(); }

  openSearch() {
    if (!isFolder(this.path)) return this.app.flash('Open a folder to search in it');
    this.closePath();
    this.find.placeholder = `Search ${tabName(this.path)} and subfolders`;
    this.crumbBox.hidden = true; this.find.hidden = false; this.find.focus(); this.find.select();
  }
  // Drops the search without drawing; go() calls it so a new folder never opens filtered.
  resetSearch() {
    clearTimeout(this.findTimer);
    if (this.query) invoke('search', { root: '', query: '', hidden: false }).catch(() => {}); // stops a running walk
    this.query = ''; this.found = null; this.searching = false; this.find.value = '';
    this.find.hidden = true; this.crumbBox.hidden = !this.input.hidden;
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
    const { query, path } = this;
    this.searching = true;
    try {
      const r = await invoke('search', { root: path, query, hidden: this.app.state.hidden });
      if (query !== this.query || path !== this.path) return; // typed on, or left the folder
      this.found = r.entries;
      if (r.truncated) this.app.flash(`Showing the first ${r.entries.length} matches; type more to narrow it`);
    } catch (err) {
      if (String(err) !== 'superseded') this.app.flash(String(err));
      if (query !== this.query) return;
    }
    this.searching = false;
    this.render(this.rows[this.cursor]?.path);
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
