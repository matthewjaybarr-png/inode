// Drag and drop: rows onto a folder row, a pane, a tab or a sidebar place; files in from other apps; files out (Linux).
// The window keeps Tauri's native drag-drop on, because only that gives real paths for files dropped in from other
// apps (WebKitGTK hides file:// URIs from the page, WebView2 never has them). What that means per platform:
//   Linux    rows drag with HTML5 events (other apps accept them too). The drop itself comes back as the native
//            event when the drag carries files, as an HTML5 `drop` otherwise: both end in drop() below.
//   Windows  native drag-drop switches HTML5 dragging off inside WebView2, so rows drag with pointer events.
//            shortcut: no drag out to other apps on Windows, that needs a native drag source (OLE DoDragDrop).
import { TRASH, BIN, WIN, isFolder, placeName, toUriList, fromUris, dropRefusal } from './util.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function setupDnd(app) {
  let drag = null; // paths dragged from this window; null while another app's files are over it
  let seen = null; // last hover { at, e }: a native drop on Linux only says where in pixels, and has no modifier keys
  let lit = null, handled = 0;
  const dev = new Map(); // "source\ndest" -> same device: the promise while asking, then the answer
  const tip = Object.assign(document.createElement('div'), { id: 'drag-tip', hidden: true });
  document.body.append(tip);

  const light = (el) => { if (lit !== el) { lit?.classList.remove('drop'); el?.classList.add('drop'); lit = el; } };
  const calm = () => { light(null); tip.hidden = true; };

  // The drop target under an element: { el (what lights up), path (TRASH = the bin), file (a pinned file) }.
  function target(at) {
    const place = at?.closest?.('.place[data-drop]'), tab = at?.closest?.('.tab'), pane = app.panes.find((p) => p.root.contains(at));
    if (place || tab) { const el = place || tab, path = el.dataset.drop; return { el, path: path.startsWith('shell:') ? TRASH : path, file: el.dataset.kind === 'file' }; }
    if (!pane || pane.path == null) return null;
    const row = pane.path !== TRASH && at.closest?.('.item.dir');
    return row ? { el: row, path: pane.rows[row.dataset.i].path } : { el: pane.root, path: pane.path };
  }

  const sameDev = (paths, dest) => {
    const k = `${paths[0]}\n${dest}`;
    if (!dev.has(k)) dev.set(k, invoke('same_device', { a: paths[0], b: dest }).catch(() => true).then((s) => { dev.set(k, s); }));
    return dev.get(k);
  };

  // What a drop on `t` would do: { say, trash } or { say, mv, dest }, or { no: why not }. `paths` is unknown (null)
  // while another app's files hover. Same drive moves, another drive copies; Ctrl copies, Shift moves; files from
  // another app are copied unless Shift is held.
  function plan(t, e, paths, ext) {
    const n = paths ? `${paths.length} item${paths.length === 1 ? '' : 's'} ` : '', name = placeName(t.path) ?? baseName(t.path);
    if (t.path === TRASH) return { trash: true, say: `Move ${n}to the ${BIN}` };
    if (t.file || !isFolder(t.path)) return { no: `${name} is not a folder` };
    const mv = e.shiftKey || (!e.ctrlKey && !ext && sameDev(paths, t.path) !== false);
    const no = paths && dropRefusal(paths, t.path, mv);
    return no ? { no } : { mv, dest: t.path, say: `${mv ? 'Move' : 'Copy'} ${n}to ${name}` };
  }

  function hover(at, e) {
    seen = { at, e };
    const t = target(at), p = t && plan(t, e, drag, !drag);
    light(p && !p.no ? t.el : null);
    tip.hidden = !p;
    if (p) { tip.textContent = p.no || p.say; tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 18}px`; }
    return p;
  }

  // Everything goes through ops.send / ops.trash, so name clashes, progress, undo and redo work as for Paste.
  async function drop(at, e, paths) {
    const ext = !drag, t = target(at), again = performance.now() - handled < 500; // one drop must never run twice
    drag = seen = null; calm();
    if (!t || !paths.length || again) return;
    handled = performance.now();
    if (isFolder(t.path)) await sameDev(paths, t.path);
    const p = plan(t, e, paths, ext);
    if (p.no) return app.flash(p.no);
    if (p.trash) return app.ops.trash(paths);
    app.ops.send(paths, p.dest, p.mv);
  }

  // The rows a drag from this row carries: the selection when the row is in it, else that row alone.
  function rowPaths(row) {
    const pane = row && app.panes.find((p) => p.root.contains(row)), e = pane?.rows[row.dataset.i];
    if (!e || pane.path === TRASH || document.querySelector('.rename-input')) return null;
    if (!pane.selected.has(e.path)) pane.click(+row.dataset.i, {});
    return [...pane.selected];
  }

  // Files from another app (and, on Linux, our own rows once the drag carries file URIs) arrive here with real paths.
  const point = (p) => { const k = devicePixelRatio || 1, x = p.x / k, y = p.y / k; return [document.elementFromPoint(x, y), { clientX: x, clientY: y }]; };
  window.__TAURI__.webviewWindow.getCurrentWebviewWindow().onDragDropEvent(({ payload: d }) => {
    if (d.type === 'drop') drop(WIN ? point(d.position)[0] : seen?.at, seen?.e ?? {}, drag || d.paths);
    else if (d.type === 'leave') calm();
    else if (WIN) hover(...point(d.position)); // Linux hovers through HTML5 dragover, which also knows the modifier keys
  });

  if (WIN) {
    addEventListener('pointerdown', (e) => {
      const row = e.button === 0 && !e.target.closest?.('input') && e.target.closest?.('.item');
      if (!row) return;
      const stop = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      const under = (ev) => document.elementFromPoint(ev.clientX, ev.clientY);
      const move = (ev) => {
        if (!ev.buttons) { stop(); drag = seen = null; return calm(); } // released outside the window
        if (!drag) {
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) return;
          dev.clear();
          if (!(drag = rowPaths(row))) return stop();
        }
        hover(under(ev), ev);
      };
      const up = (ev) => { stop(); if (drag) drop(under(ev), ev, drag); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    return;
  }

  addEventListener('dragstart', (e) => {
    const paths = rowPaths(e.target.closest?.('.item'));
    if (!paths) return e.preventDefault(); // nothing else in the window is draggable
    drag = paths; dev.clear();
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/uri-list', toUriList(paths));
    e.dataTransfer.setData('text/plain', paths.join('\n'));
  });
  addEventListener('dragover', (e) => {
    e.preventDefault(); // also keeps the webview from opening a dropped file as a page
    if (!drag && !e.dataTransfer.types.some((t) => t === 'Files' || t === 'text/uri-list')) return calm(); // dragged text, not files
    const p = hover(e.target, e);
    e.dataTransfer.dropEffect = !p || p.no ? 'none' : p.mv || p.trash ? 'move' : 'copy';
  });
  addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = drag || fromUris(e.dataTransfer.getData('text/uri-list')).paths;
    if (paths.length) drop(e.target, e, paths); // none: the native event brings them
  });
  // Leaving the window (not just moving from one element to the next).
  addEventListener('dragleave', (e) => { if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight) calm(); });
  // The native drop event arrives a moment after dragend, so the dragged paths are kept that long.
  addEventListener('dragend', () => { const d = drag; calm(); setTimeout(() => { if (drag === d) drag = seen = null; }, 500); });
}
