// Pick mode: this window is another app's Open or Save dialog (the file chooser portal, portal.rs). A bar above the
// status line holds the caller's title, the file-type filter, the name box (Save) and the accept and Cancel buttons.
// The window browses like any Inode window but keeps nothing: no tabs, layout or settings are saved from it.
import { isFolder, TRASH } from './util.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// A file-name glob as the portal's filters use them ("*.txt", "*.[jJ][pP][gG]", "?" one character) as a test.
// Letter case is ignored, so "*.jpg" also shows PHOTO.JPG.
const tests = new Map();
export function globTest(glob) {
  if (!tests.has(glob)) {
    const body = glob.replace(/\[!?[^\]]*\]|[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? '.*' : m === '?' ? '.' : m.length > 1 ? m.replace(/^\[!/, '[^').replace(/\\/g, '\\\\') : `\\${m}`));
    let re; try { re = new RegExp(`^${body}$`, 'i'); } catch { re = /^/; } // a glob we cannot read hides nothing
    tests.set(glob, re);
  }
  return tests.get(glob);
}
// Whether a file name fits a filter ({ name, globs }); no filter, or one without globs, fits everything.
export const fits = (filter, name) => !filter?.globs.length || filter.globs.some((g) => globTest(g).test(name));

// What the accept button does now. `req` is the caller's request; `at` is the pane: { path, entries (everything in
// the folder), selected (the selected rows), cursor (the row under it, or null), name (the name box) }.
// Gives { paths } to answer with (and { replace: [names] } that exist and need a yes first), { go } a folder to
// open instead, or { say } why there is nothing to answer yet.
export function choose(req, at) {
  const join = (name) => `${at.path.replace(/\/+$/, '')}/${name}`;
  if (req.mode === 'open' && !req.directory) {
    if (at.path === TRASH) return { say: 'Restore an item from the Trash before choosing it' };
    const rows = at.selected.length ? at.selected : at.cursor ? [at.cursor] : [];
    if (rows.length === 1 && rows[0].dir) return { go: rows[0].path };
    const files = rows.filter((e) => !e.dir);
    if (!files.length) return { say: 'Select a file first' };
    if (files.length > 1 && !req.multiple) return { say: 'This app asked for one file: select just one' };
    return { paths: files.map((e) => e.path) };
  }
  if (!isFolder(at.path)) return { say: 'Open a real folder first: this is a list' };
  if (req.mode === 'open') {
    // A folder: the selected one(s), else the folder this pane shows.
    const dirs = at.selected.filter((e) => e.dir);
    if (dirs.length > 1 && !req.multiple) return { say: 'This app asked for one folder: select just one, or none to choose this folder' };
    return { paths: dirs.length ? dirs.map((e) => e.path) : [at.path] };
  }
  const here = new Map(at.entries.map((e) => [e.name, e]));
  if (req.mode === 'saveFiles') return { paths: req.files.map(join), replace: req.files.filter((n) => here.has(n)) };
  const name = at.name.trim();
  if (!name) return { say: 'Type a file name first' };
  if (name.includes('/') || name === '.' || name === '..') return { say: 'A file name cannot contain / (open the folder instead, then type the name)' };
  if (here.get(name)?.dir) return { go: here.get(name).path };
  return { paths: [join(name)], replace: here.has(name) ? [name] : [] };
}

export function setupPick(app, req) {
  // Nothing of this window is saved (saveState checks app.pick), so its layout can be set freely: one pane, the
  // caller's folder or else the one visited last.
  Object.assign(app.state, { dual: false, preview: false, tabs: [], paths: [app.state.recents?.[0] ?? app.home] });
  document.body.classList.add('picking');
  // A chooser picks; it does not delete or run the user's own commands (menu, palette, keys and drops all end here).
  const off = () => app.flash('Deleting is off in a file chooser: use an Inode window');
  Object.assign(app.ops, { trash: off, purge: off, deleteForever: off });
  app.actionItems = () => [];

  const bar = el('div'); bar.id = 'pick-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', req.title);
  const types = el('select'), ok = el('button', 'primary', req.accept), cancel = el('button', '', 'Cancel');
  const nameBox = req.mode === 'save' ? el('input', 'path-input') : null;
  req.filters.forEach((f, i) => types.append(new Option(f.name, i)));
  types.value = req.filter; types.hidden = !req.filters.length || req.directory;
  types.title = 'Which files to show'; types.setAttribute('aria-label', types.title);
  ok.title = `${req.accept} (Enter on a file, or Ctrl+Shift+Enter)`; cancel.title = 'Cancel (Esc)';
  bar.append(el('strong', '', req.title));
  if (req.mode === 'saveFiles') bar.append(el('span', 'pick-note', `${req.files.length} file${req.files.length === 1 ? '' : 's'} will be saved into the folder you choose`));
  if (nameBox) {
    nameBox.value = req.name; nameBox.spellcheck = false; nameBox.placeholder = 'File name'; nameBox.setAttribute('aria-label', 'File name');
    nameBox.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); accept(); } else if (e.key === 'Escape') { e.preventDefault(); app.pane().list.focus(); }
    };
    bar.append(nameBox);
  }
  bar.append(types, ok, cancel);
  document.querySelector('#status').before(bar);

  const done = (paths) => invoke('pick_done', { paths, filter: Number(types.value) || 0 }).catch((e) => app.flash(String(e)));
  async function accept() {
    const p = app.pane();
    const r = choose(req, { path: p.path, entries: p.entries, selected: p.rows.filter((e) => p.selected.has(e.path)), cursor: p.rows[p.cursor] || null, name: nameBox?.value || '' });
    if (r.say) return app.flash(r.say);
    if (r.go) return p.go(r.go);
    if (r.replace?.length) {
      const what = r.replace.length === 1 ? `"${r.replace[0]}" already exists` : `${r.replace.length} of these files already exist`;
      if (!(await app.ops.ask(`${what} in ${p.path}. Replace?`, [{ id: 'yes', label: 'Replace', danger: true }, { id: null, label: 'Cancel', focus: true }]))) return;
    }
    done(r.paths);
  }
  ok.onclick = accept; cancel.onclick = () => done(null);
  types.onchange = () => { app.panes.forEach((p) => p.path != null && p.render(p.rows[p.cursor]?.path)); app.pane().list.focus(); };

  app.pick = {
    accept,
    // Esc clears a filter or search first, like everywhere else; then it cancels the dialog.
    cancel() { const p = app.pane(); if (p.filter || p.query) p.key({ key: 'Escape' }); else done(null); },
    // Pane.render: folders always show, files when the chosen type fits (all of them when a folder is asked for).
    shows: (e) => e.dir || req.directory || fits(req.filters[types.value], e.name),
    // Pane.activate on a file (Enter, double-click): Open answers with it, Save takes its name and asks before replacing it.
    activate(e) {
      if (req.directory) return app.flash('This app asked for a folder: open the one you want, then choose it');
      const p = app.pane();
      if (nameBox) nameBox.value = e.name; else { p.selected = new Set([e.path]); p.paintCursor(false); }
      accept();
    },
    // Where the keyboard starts: the name box for Save (the name without its extension selected), else the list.
    focus() { if (!nameBox) return; nameBox.focus(); const dot = nameBox.value.lastIndexOf('.'); nameBox.setSelectionRange(0, dot > 0 ? dot : nameBox.value.length); },
  };
}
