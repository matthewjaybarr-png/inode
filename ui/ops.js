// File operations: a one-at-a-time queue with progress, in-app prompts (WebView2 ignores confirm()), and undo.
import { formatSize, extOf, BIN, TRASH, placeName, isFolder, archiveStem, toUriList, fromUris } from './util.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const $ = (s) => document.querySelector(s);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const parentOf = (p) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || '/';
const sameDir = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

export function setupOps(app) {
  const queue = [];
  const undo = [], redo = [];
  const marks = () => { $('#btn-undo').disabled = !undo.length; $('#btn-redo').disabled = !redo.length; };
  let running = null;
  let prompt = null; // { resolve, keys }
  let spent = null; // paths of a cut already pasted: the system clipboard still lists them, but they have moved
  let clip = null; // { paths, mv, pub, local } from Cut/Copy: the fast path; the system clipboard carries the same files

  const paint = () => {
    const el = $('#progress');
    el.hidden = !running;
    if (!running) return;
    const p = running.progress, pct = p && p.total ? Math.floor((100 * p.done) / p.total) : 0;
    el.querySelector('.label').textContent = `${running.label}${p?.total ? ` · ${pct}% of ${formatSize(p.total)}` : ''}${queue.length ? ` · ${queue.length} waiting` : ''}`;
    el.querySelector('.bar i').style.width = `${pct}%`;
    marks();
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
  // `again` (optional) does the operation once more and records its own undo: that is what Redo runs, passing
  // `redone` so the rest of the redo stack is kept. Any fresh operation clears the redo stack.
  const pushUndo = (label, fn, again, redone) => {
    undo.push({ label, fn, again }); if (undo.length > 50) undo.shift();
    if (!redone) redo.length = 0;
    marks();
  };
  // True in a real folder. Trash, Recent and This PC are lists: there it says why the command did nothing.
  const inFolder = (p, what) => isFolder(p.path) || (app.flash(`${placeName(p.path) ?? 'This'} is a list, not a folder: open a folder to ${what}`), false);

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
    const run = async (redone) => {
      const pairs = await invoke('transfer', { sources, dest, mv, policy });
      app.flash(`${mv ? 'Moved' : 'Copied'} ${plural(pairs.length, 'item')} to ${baseName(dest)}`);
      // Undoing a copy sends the copies to the bin (recoverable). A copy that replaced files has no undo: they are gone.
      const back = mv ? () => invoke('move_back', { pairs }) : async () => {
        const { failed } = await invoke('trash', { paths: pairs.map((p) => p[1]) });
        if (failed.length) throw failed.join(' · ');
      };
      if (pairs.length && (mv || policy !== 'replace')) pushUndo(`${mv ? 'move' : 'copy'} of ${plural(pairs.length, 'item')}`, back, run, redone);
    };
    enqueue(`${verb} ${plural(sources.length, 'item')} to ${baseName(dest)}`, run);
  }

  const ops = {
    get prompting() { return !!prompt; },
    send,

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
      if (src.path === TRASH) return app.flash(`Restore items from the ${BIN} first (Alt+R), then copy or move them`);
      if (!isFolder(dst.path)) return app.flash(`${placeName(dst.path)} in the other pane is a list, not a folder: open a folder there first`);
      const sources = src.targets();
      if (!sources.length) return;
      await send(sources, dst.path, mv);
      src.selected.clear();
    },

    // Cut/Copy remember paths inside the app and put them on the system clipboard for other apps (Explorer is told
    // cut or copy; on Linux other apps see a copy). Paste copies or moves into the active pane's folder.
    clip(mv) {
      const p = app.pane(), paths = p.targets();
      if (!paths.length || !p.path) return;
      if (p.path === TRASH) return app.flash(`Restore items from the ${BIN} first (Alt+R), then cut or copy them`);
      const c = clip = { paths, mv };
      spent = null;
      // `local` = the system clipboard could not be set (no wl-copy, X11 session): the in-app clip still pastes here.
      c.pub = invoke('clip_write', { paths, uris: toUriList(paths), mv }).catch(() => { c.local = true; });
      app.flash(`${mv ? 'Cut' : 'Copied'} ${plural(paths.length, 'item')} · Ctrl+V pastes`);
    },

    async paste(dest = app.pane().path) {
      if (!isFolder(dest)) return app.flash(`${placeName(dest) ?? 'This'} is a list, not a folder: open a folder to paste into it`);
      await clip?.pub;
      // The system clipboard decides (another app may have copied since); when it cannot be read the in-app clip stands.
      const sys = await invoke('clip_read').then(fromUris, () => null);
      const ours = clip && sys?.paths.length === clip.paths.length && sys.paths.every((p, i) => sameDir(p, clip.paths[i]));
      const c = !sys || ours || (clip?.local && !sys.paths.length) ? clip : sys.paths.length ? sys : null;
      if (!c) return app.flash('Nothing to paste: Ctrl+C or Ctrl+X some items first, here or in another app');
      if (c.mv && c.paths.every((s) => sameDir(parentOf(s), dest))) return app.flash('Already in this folder');
      if (c === sys && spent && sys.paths.length === spent.length && sys.paths.every((p, i) => p === spent[i])) return app.flash('Nothing to paste: that cut was already pasted');
      if (c.mv) { spent = c.paths; if (c === clip) clip = null; } // a cut (ours or Explorer's) pastes once, like Explorer
      await send(c.paths, dest, c.mv);
    },

    rename() {
      const p = app.pane(), e = p.rows[p.cursor];
      if (!e || !inFolder(p, 'rename things')) return;
      p.startRename(e.path, async (name) => {
        if (!name || name === e.name) return;
        const ext = (n) => (extOf(n) ? `.${extOf(n)}` : 'no extension');
        if (app.state.warnExt && !e.dir && extOf(name) !== extOf(e.name) && (await ask(`Change the extension of "${e.name}" from ${ext(e.name)} to ${ext(name)}? It may then open in a different app, or not at all.`, [
          { id: 'rename', label: 'Rename' },
          { id: null, label: 'Cancel', focus: true },
        ])) !== 'rename') return;
        const run = async (redone) => {
          const to = await invoke('rename_path', { path: e.path, name });
          pushUndo(`rename to ${name}`, () => invoke('rename_path', { path: to, name: e.name }), run, redone);
          if (redone) app.flash(`Renamed ${e.name} to ${name} again`);
          return to;
        };
        const to = await run();
        await p.refresh(); p.render(to);
      });
    },

    // New folder (or file): create and name in one go. Enter (or an empty name) keeps it; Esc removes it again if
    // still empty, so cancelling leaves nothing behind. A taken or invalid name reopens the box with what was typed.
    async newItem(folder = true) {
      const p = app.pane(), where = p.path, word = folder ? 'folder' : 'file';
      if (!inFolder(p, `make a new ${word} in it`)) return;
      let cur;
      try { cur = await invoke('new_item', { dir: where, folder }); } catch (err) { return app.flash(String(err)); }
      await p.go(where, { push: false, keep: cur });
      const cancel = async () => {
        await invoke('remove_empty', { path: cur }).then(() => app.flash(`Cancelled: no new ${word} was made`), (err) => app.flash(String(err)));
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
        const made = cur, label = `new ${word} ${baseName(made)}`, back = () => invoke('remove_empty', { path: made });
        const again = async () => {
          await invoke('new_item', { dir: where, name: baseName(made), folder });
          pushUndo(label, back, again, true);
          app.flash(`Made ${baseName(made)} in ${where} again`);
        };
        pushUndo(label, back, again);
        app.flash(`Made ${baseName(made)} in ${where} · Ctrl+Z removes it while it is still empty`);
      };
      p.startRename(cur, commit, cancel);
      app.flash(`New ${word} in ${where} · type a name, Enter keeps it, Esc cancels`);
    },

    // Normal Delete = the system bin, undoable. Where there is none (Windows network/removable drives) it asks
    // before a permanent delete, Cancel focused. Items that fail are left in place and named.
    // `dropped` = paths dragged onto the sidebar bin, instead of the active pane's selection.
    async trash(dropped) {
      const p = app.pane(), paths = dropped ?? p.targets();
      if (!dropped && p.path === TRASH) return ops.purge(false);
      if (!dropped && !inFolder(p, 'delete things in it')) return;
      if (!paths.length) return app.flash('Nothing to delete: select a file or folder first');
      const what = paths.length === 1 ? `"${baseName(paths[0])}"` : plural(paths.length, 'item');
      if (!(await invoke('has_bin', { dir: dropped ? parentOf(paths[0]) : p.path }).catch(() => false))) {
        const ok = await ask(`This drive has no ${BIN}, so ${what} cannot be undone if deleted. Delete permanently?`, [
          { id: 'delete', label: 'Delete permanently', danger: true },
          { id: null, label: 'Cancel', focus: true },
        ]);
        if (ok === 'delete') enqueue(`Deleting ${what}`, async () => { await invoke('delete_paths', { paths }); app.flash(`Deleted ${what} permanently`); });
        return;
      }
      // Settings: "Ask before sending to the bin". Delete again confirms (not a held key's repeats), like Shift+Delete does.
      if (app.state.askBin && (await ask(`Move ${what} to the ${BIN}? Delete again confirms.`, [
        { id: 'bin', label: `Move to ${BIN}`, danger: true },
        { id: null, label: 'Cancel', focus: true },
      ], { bin: (e) => e.key === 'Delete' && !e.shiftKey && !e.repeat })) !== 'bin') return;
      const run = async (redone) => {
        const { items, failed } = await invoke('trash', { paths });
        if (items.length) pushUndo(`delete of ${plural(items.length, 'item')}`, () => invoke('restore', { items }), run, redone);
        const moved = items.length ? `Moved ${plural(items.length, 'item')} to the ${BIN} · Ctrl+Z puts ${items.length === 1 ? 'it' : 'them'} back` : '';
        app.flash([moved, ...failed].filter(Boolean).join(' · '));
      };
      enqueue(`Moving ${what} to the ${BIN}`, run);
    },

    // Trash view: put the selection (or everything) back where it came from. A name taken again comes back as "name (2)".
    restore(all) {
      const p = app.pane(), paths = all ? null : p.targets();
      if (p.path !== TRASH) return app.flash(`Restore works in the ${BIN}: open it from the sidebar first`);
      if (!p.entries.length || (paths && !paths.length)) return app.flash(`Nothing to restore: the ${BIN} is empty`);
      const what = all ? 'everything' : plural(paths.length, 'item');
      enqueue(`Restoring ${what} from the ${BIN}`, async () => {
        const notes = await invoke('trash_restore', { paths });
        app.flash([`Restored ${what}`, ...notes].join(' · '));
      });
    },

    // Trash view: delete the selection for good, or (all) empty it. Always asks first, Cancel focused.
    async purge(all) {
      const p = app.pane(), paths = all ? null : p.targets();
      if (p.path !== TRASH) return app.flash(`Open the ${BIN} from the sidebar first`);
      if (!p.entries.length || (paths && !paths.length)) return app.flash(`The ${BIN} is already empty`);
      const n = all ? p.entries.length : paths.length;
      const what = n === 1 ? `"${(all ? p.entries[0] : p.entries.find((e) => e.path === paths[0]))?.name}"` : plural(n, 'item');
      const ok = await ask(all ? `Empty the ${BIN}? This deletes ${what} permanently and cannot be undone.` : `Delete ${what} permanently from the ${BIN}? This cannot be undone.`, [
        { id: 'delete', label: all ? `Empty ${BIN}` : 'Delete permanently', danger: true },
        { id: null, label: 'Cancel', focus: true },
      ]);
      if (ok !== 'delete') return;
      enqueue(all ? `Emptying the ${BIN}` : `Deleting ${what}`, async () => {
        const gone = await invoke('trash_purge', { paths });
        app.flash(`Deleted ${plural(gone, 'item')} permanently`);
      });
    },

    // Unpacks the archive under the cursor beside itself: loose ("here") or into a folder named after it.
    // Existing names are never overwritten (keep-both naming); Undo removes what came out while it is unchanged.
    extract(toFolder) {
      const p = app.pane(), e = p.rows[p.cursor], stem = e && !e.dir ? archiveStem(e.name) : '';
      if (!inFolder(p, 'extract an archive in it')) return;
      if (!stem) return app.flash('Extract works on an archive (.zip .7z .rar .tar .tar.gz .tgz .tar.xz .tar.zst .tar.bz2): put the cursor on one');
      enqueue(`Extracting ${e.name}`, async () => {
        const made = await invoke('extract', { archive: e.path, folder: toFolder ? stem : null });
        if (made.length) pushUndo(`extract of ${e.name}`, () => invoke('undo_extract', { made }));
        app.flash(!made.length ? `${e.name} is empty: nothing to extract` : toFolder ? `Extracted ${e.name} to folder ${baseName(made[0][0])}` : `Extracted ${plural(made.length, 'item')} from ${e.name}`);
      });
    },

    // Shift+Delete arms; Shift+Delete again (or the button) deletes. Cancel has focus, so a stray Enter is safe.
    async deleteForever() {
      const p = app.pane(), paths = p.targets();
      if (p.path === TRASH) return ops.purge(false);
      if (!paths.length || !inFolder(p, 'delete things in it')) return;
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

    // A shortcut (Windows: "name - Shortcut.lnk", Linux: the symlink "Link to name") beside each selected item.
    // Undo sends the shortcuts to the bin; the items themselves are never touched.
    shortcut() {
      const p = app.pane(), paths = p.targets();
      if (!paths.length || !inFolder(p, 'make a shortcut in it')) return;
      const run = async (redone) => {
        const made = [];
        try { for (const path of paths) made.push(await invoke('make_link', { path })); } finally {
          if (made.length) {
            pushUndo(`shortcut to ${plural(made.length, 'item')}`, async () => {
              const { failed } = await invoke('trash', { paths: made });
              if (failed.length) throw failed.join(' · ');
            }, run, redone);
          }
        }
        app.flash(`Made ${made.length === 1 ? baseName(made[0]) : plural(made.length, 'shortcut')} · Ctrl+Z removes ${made.length === 1 ? 'it' : 'them'}`);
      };
      enqueue(`Making ${plural(paths.length, 'shortcut')}`, run);
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
      const u = undo.pop(); marks();
      if (!u) return app.flash('Nothing to undo');
      enqueue(`Undoing ${u.label}`, async () => {
        const notes = await u.fn();
        if (u.again) { redo.push(u); marks(); }
        app.flash([`Undid ${u.label}`, ...(Array.isArray(notes) ? notes : [])].join(' · '));
      });
    },

    // Does the last undone operation again; it lands back on the undo stack.
    redo() {
      const r = redo.pop(); marks();
      if (!r) return app.flash('Nothing to redo');
      enqueue(`Redoing ${r.label}`, () => r.again(true));
    },
  };

  $('#btn-new').onclick = () => ops.newItem(true);
  $('#btn-newfile').onclick = () => ops.newItem(false);
  $('#btn-newfile').onmousedown = (e) => e.preventDefault();
  $('#btn-redo').onclick = () => ops.redo();
  $('#btn-rename').onclick = () => ops.rename();
  $('#btn-new').onmousedown = (e) => e.preventDefault(); // keep focus off the button so the name box keeps it
  $('#btn-copy').onclick = () => ops.transfer(false);
  $('#btn-move').onclick = () => ops.transfer(true);
  $('#btn-trash').onclick = () => { app.pane().list.focus(); ops.trash(); };
  $('#btn-undo').onclick = () => ops.undo();
  return ops;
}
