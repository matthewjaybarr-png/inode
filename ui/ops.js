// File operations: a one-at-a-time queue with progress, in-app prompts (WebView2 ignores confirm()), and undo.
import { formatSize, BIN } from './util.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const $ = (s) => document.querySelector(s);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const parentOf = (p) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || '/';
const sameDir = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

export function setupOps(app) {
  const queue = [];
  const undo = [];
  let running = null;
  let prompt = null; // { resolve, keys }
  let clip = null; // { paths, mv } from Cut/Copy

  const paint = () => {
    const el = $('#progress');
    el.hidden = !running;
    if (!running) return;
    const p = running.progress, pct = p && p.total ? Math.floor((100 * p.done) / p.total) : 0;
    el.querySelector('.label').textContent = `${running.label}${p?.total ? ` · ${pct}% of ${formatSize(p.total)}` : ''}${queue.length ? ` · ${queue.length} waiting` : ''}`;
    el.querySelector('.bar i').style.width = `${pct}%`;
    $('#btn-undo').disabled = !undo.length;
  };

  window.__TAURI__.event.listen('op-progress', (e) => { if (running) { running.progress = e.payload; paint(); } });

  async function pump() {
    if (running || !queue.length) return;
    running = queue.shift(); paint();
    try { await running.run(); } catch (err) { app.flash(String(err)); }
    running = null; paint();
    await Promise.all(app.panes.map((p) => p.refresh()));
    pump();
  }
  const enqueue = (label, run) => { queue.push({ label, run }); paint(); pump(); };
  const pushUndo = (label, fn) => { undo.push({ label, fn }); if (undo.length > 50) undo.shift(); $('#btn-undo').disabled = false; };

  // A bar above the status line: message plus buttons; resolves with the button's id, or null on Escape.
  function ask(message, buttons, keys = {}) {
    const box = $('#prompt');
    box.replaceChildren();
    const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = message;
    box.append(msg);
    return new Promise((resolve) => {
      const done = (v) => { prompt = null; box.hidden = true; app.pane().list.focus(); resolve(v); };
      let first = null;
      for (const b of buttons) {
        const el = document.createElement('button');
        el.textContent = b.label; el.className = b.danger ? 'danger' : b.primary ? 'primary' : '';
        el.onclick = () => done(b.id);
        box.append(el);
        if (b.focus) first = el;
      }
      box.hidden = false;
      prompt = { done, keys };
      (first || box.querySelector('button')).focus();
    });
  }

  // Copies or moves into dest, asking about name clashes first.
  async function send(sources, dest, mv) {
    const clash = await invoke('conflicts', { sources, dest });
    // A copy into the same folder is always "keep both"; no question needed.
    let policy = 'keepBoth';
    if (clash.length && !sources.every((s) => sameDir(parentOf(s), dest))) {
      policy = await ask(`${clash.length === 1 ? `"${clash[0]}" already exists` : `${clash.length} items already exist`} in ${baseName(dest)}.`, [
        { id: 'keepBoth', label: 'Keep both', primary: true, focus: true },
        { id: 'replace', label: 'Replace' },
        { id: 'skip', label: 'Skip those' },
        { id: null, label: 'Cancel' },
      ]);
      if (!policy) return;
    }
    const verb = mv ? 'Moving' : 'Copying';
    enqueue(`${verb} ${plural(sources.length, 'item')} to ${baseName(dest)}`, async () => {
      const pairs = await invoke('transfer', { sources, dest, mv, policy });
      app.flash(`${mv ? 'Moved' : 'Copied'} ${plural(pairs.length, 'item')} to ${baseName(dest)}`);
      if (mv && pairs.length) pushUndo(`move of ${plural(pairs.length, 'item')}`, () => invoke('move_back', { pairs }));
    });
  }

  const ops = {
    get prompting() { return !!prompt; },
    get hasClip() { return !!clip; },

    // Keys while a prompt is up: Escape cancels, a prompt's own hotkeys answer it, Tab/Enter/Space work the buttons.
    promptKey(e) {
      if (!prompt) return false;
      const hit = Object.entries(prompt.keys).find(([, test]) => test(e));
      if (e.key === 'Escape') { e.preventDefault(); prompt.done(null); }
      else if (hit) { e.preventDefault(); prompt.done(hit[0]); }
      else if (!['Tab', 'Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
      else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const bs = [...$('#prompt').querySelectorAll('button')], i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]?.focus();
      }
      return true;
    },

    async transfer(mv) {
      const src = app.pane(), dst = app.other();
      if (!app.state.dual || !dst?.path) return app.flash('Turn on the second pane (F3) to pick where it goes');
      const sources = src.targets();
      if (!sources.length) return;
      await send(sources, dst.path, mv);
      src.selected.clear();
    },

    // Cut/Copy remember paths inside the app; Paste copies or moves them into the active pane's folder.
    clip(mv) {
      const p = app.pane(), paths = p.targets();
      if (!paths.length || !p.path) return;
      clip = { paths, mv };
      app.flash(`${mv ? 'Cut' : 'Copied'} ${plural(paths.length, 'item')} · Ctrl+V pastes`);
    },

    async paste(dest = app.pane().path) {
      if (!clip) return app.flash('Nothing to paste: Ctrl+C or Ctrl+X some items first');
      if (!dest) return;
      if (clip.mv && clip.paths.every((s) => sameDir(parentOf(s), dest))) return app.flash('Already in this folder');
      const { paths, mv } = clip;
      if (mv) clip = null; // a cut pastes once, like Explorer
      await send(paths, dest, mv);
    },

    rename() {
      const p = app.pane(), e = p.rows[p.cursor];
      if (!e || !p.path) return;
      p.startRename(e.path, async (name) => {
        if (!name || name === e.name) return;
        const to = await invoke('rename_path', { path: e.path, name });
        pushUndo(`rename to ${name}`, () => invoke('rename_path', { path: to, name: e.name }));
        await p.refresh(); p.render(to);
      });
    },

    // Create and name in one go. Enter (or an empty name) keeps it; Esc removes it again if still empty,
    // so cancelling leaves nothing behind. A taken or invalid name reopens the box with what was typed.
    async newFolder() {
      const p = app.pane(), where = p.path;
      if (!where) return app.flash('This PC lists drives, not a folder: open a drive or folder first, then New folder.');
      let cur;
      try { cur = await invoke('new_folder', { dir: where }); } catch (err) { return app.flash(String(err)); }
      await p.go(where, { push: false, keep: cur });
      const cancel = async () => {
        await invoke('remove_empty_folder', { path: cur }).then(() => app.flash('Cancelled: no new folder was made'), (err) => app.flash(String(err)));
        await p.refresh();
      };
      const commit = async (name) => {
        if (name && name !== baseName(cur)) {
          try { cur = await invoke('rename_path', { path: cur, name }); } catch (err) {
            app.flash(`${err} · type another name, or Esc to cancel`);
            return p.startRename(cur, commit, cancel, name);
          }
          await p.refresh(); p.render(cur);
        }
        const made = cur;
        pushUndo(`new folder ${baseName(made)}`, () => invoke('remove_empty_folder', { path: made }));
        app.flash(`Made ${baseName(made)} in ${where} · Ctrl+Z removes it while it is still empty`);
      };
      p.startRename(cur, commit, cancel);
      app.flash(`New folder in ${where} · type a name, Enter keeps it, Esc cancels`);
    },

    // Normal Delete = the system bin, undoable. Where there is none (Windows network/removable drives) it asks
    // before a permanent delete, Cancel focused. Items that fail are left in place and named.
    async trash() {
      const p = app.pane(), paths = p.targets();
      if (!p.path) return;
      if (!paths.length) return app.flash('Nothing to delete: select a file or folder first');
      const what = paths.length === 1 ? `"${baseName(paths[0])}"` : plural(paths.length, 'item');
      if (!(await invoke('has_bin', { dir: p.path }).catch(() => false))) {
        const ok = await ask(`This drive has no ${BIN}, so ${what} cannot be undone if deleted. Delete permanently?`, [
          { id: 'delete', label: 'Delete permanently', danger: true },
          { id: null, label: 'Cancel', focus: true },
        ]);
        if (ok === 'delete') enqueue(`Deleting ${what}`, async () => { await invoke('delete_paths', { paths }); app.flash(`Deleted ${what} permanently`); });
        return;
      }
      enqueue(`Moving ${what} to the ${BIN}`, async () => {
        const { items, failed } = await invoke('trash', { paths });
        if (items.length) pushUndo(`delete of ${plural(items.length, 'item')}`, () => invoke('restore', { items }));
        const moved = items.length ? `Moved ${plural(items.length, 'item')} to the ${BIN} · Ctrl+Z puts ${items.length === 1 ? 'it' : 'them'} back` : '';
        app.flash([moved, ...failed].filter(Boolean).join(' · '));
      });
    },

    // Shift+Delete arms; Shift+Delete again (or the button) deletes. Cancel has focus, so a stray Enter is safe.
    async deleteForever() {
      const p = app.pane(), paths = p.targets();
      if (!paths.length || !p.path) return;
      const what = paths.length === 1 ? `"${baseName(paths[0])}"` : plural(paths.length, 'item');
      const ok = await ask(`Delete ${what} permanently, without the ${BIN}? This cannot be undone. Shift+Delete again confirms.`, [
        { id: 'delete', label: 'Delete permanently', danger: true },
        { id: null, label: 'Cancel', focus: true },
      ], { delete: (e) => e.key === 'Delete' && e.shiftKey });
      if (ok !== 'delete') return;
      enqueue(`Deleting ${what}`, async () => {
        await invoke('delete_paths', { paths });
        app.flash(`Deleted ${what}`);
      });
    },

    // Zip the selection beside it; progress shows in the same bar as copies.
    compress(paths = app.pane().targets()) {
      if (!paths.length) return;
      enqueue(`Compressing ${plural(paths.length, 'item')}`, async () => {
        const zip = await invoke('compress', { sources: paths });
        app.flash(`Created ${baseName(zip)}`);
      });
    },

    async undo() {
      const u = undo.pop();
      $('#btn-undo').disabled = !undo.length;
      if (!u) return app.flash('Nothing to undo');
      enqueue(`Undoing ${u.label}`, async () => {
        const notes = await u.fn();
        app.flash([`Undid ${u.label}`, ...(Array.isArray(notes) ? notes : [])].join(' · '));
      });
    },

    key(e) {
      const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (e.key === 'F2') ops.rename();
      else if (ctrl && e.shiftKey && k === 'n') ops.newFolder();
      else if (e.key === 'Delete' && e.shiftKey) ops.deleteForever();
      else if (e.key === 'Delete') ops.trash();
      else if (ctrl && e.shiftKey && k === 'c') ops.transfer(false);
      else if (ctrl && e.shiftKey && k === 'x') ops.transfer(true);
      else if (ctrl && !e.shiftKey && k === 'z') ops.undo();
      else return false;
      return true;
    },
  };

  $('#btn-new').onclick = () => ops.newFolder();
  $('#btn-rename').onclick = () => ops.rename();
  $('#btn-new').onmousedown = (e) => e.preventDefault(); // keep focus off the button so the name box keeps it
  $('#btn-copy').onclick = () => ops.transfer(false);
  $('#btn-move').onclick = () => ops.transfer(true);
  $('#btn-trash').onclick = () => { app.pane().list.focus(); ops.trash(); };
  $('#btn-undo').onclick = () => ops.undo();
  return ops;
}
