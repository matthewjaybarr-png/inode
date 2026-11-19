// Pure helpers (no DOM, no Tauri) so node --test can cover them.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || p === '';

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// Folders first, then by key; ties fall back to name so the order is stable.
export function sortEntries(entries, key = 'name', reverse = false) {
  const by = {
    name: (a, b) => collator.compare(a.name, b.name),
    size: (a, b) => a.size - b.size,
    date: (a, b) => a.mtime - b.mtime,
    kind: (a, b) => collator.compare(extOf(a.name), extOf(b.name)),
  }[key] || ((a, b) => collator.compare(a.name, b.name));
  const dir = reverse ? -1 : 1;
  return [...entries].sort((a, b) => (b.dir - a.dir) || (by(a, b) * dir) || collator.compare(a.name, b.name));
}

export function formatSize(n, dir) {
  if (dir) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

// Compact, Explorer-like: "Today 08:52", "Nov 12 08:52" this year, "Nov 12, 2025" older.
export function formatDate(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms), t = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === t.toDateString()) return `Today ${time}`;
  if (d.getFullYear() === t.getFullYear()) return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// 0o755 -> "rwxr-xr-x (755)"
export function formatMode(m) {
  const bits = [...'rwxrwxrwx'].map((c, i) => (m & (256 >> i) ? c : '-')).join('');
  return `${bits} (${(m & 0o777).toString(8).padStart(3, '0')})`;
}

export function kindOf(e) {
  if (e.dir) return 'Folder';
  const x = extOf(e.name);
  return x ? `${x.toUpperCase()} file` : 'File';
}

// Breadcrumb segments: [{name, path}]. Windows paths start at "This PC" (the drives list, path "").
export function crumbs(path) {
  if (path && placeName(path)) return [{ name: placeName(path), path }];
  if (isWinPath(path)) {
    const out = [{ name: 'This PC', path: '' }];
    if (!path) return out;
    const parts = path.split(/[\\/]+/).filter(Boolean);
    let acc = '';
    parts.forEach((p, i) => { acc = i === 0 ? `${p}\\` : `${acc}${acc.endsWith('\\') ? '' : '\\'}${p}`; out.push({ name: p, path: acc }); });
    return out;
  }
  const out = [{ name: '/', path: '/' }];
  let acc = '';
  for (const p of path.split('/').filter(Boolean)) { acc += `/${p}`; out.push({ name: p, path: acc }); }
  return out;
}

// Turns what the user typed in the path field into a path ("~" = home).
export function resolveTyped(text, home) {
  let t = text.trim();
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) t = home + t.slice(1);
  if (t.startsWith('file://')) t = decodeURIComponent(t.slice(7));
  if (/^[A-Za-z]:$/.test(t)) t += '\\';
  return t;
}

// Sidebar: what to draw. `side` = { hide: [paths], fold: [group names] }. Hiding is only a view choice:
// a hidden place keeps working everywhere else (typed paths, This PC, pins). Pins are never hidden, only unpinned.
const GROUP = (kind) => (kind === 'drive' || kind === 'computer' ? 'Drives' : 'Places');
export function sidebarModel(pins, places, side = {}) {
  const hide = new Set(side.hide || []), fold = new Set(side.fold || []);
  const groups = [
    { name: 'Pinned', items: pins.map((path) => ({ kind: 'pin', path, name: path.split(/[\\/]/).filter(Boolean).pop() || path })) },
    ...['Places', 'Drives'].map((name) => ({ name, items: places.filter((p) => GROUP(p.kind) === name && !hide.has(p.path)) })),
  ].filter((g) => g.items.length || g.name === 'Pinned').map((g) => ({ ...g, folded: fold.has(g.name) }));
  // A hidden place that is gone right now (unplugged, disconnected) stays listed, so it stays hidden when it returns.
  const known = new Map(places.map((p) => [p.path, p]));
  const hidden = [...hide].map((path) => known.get(path) || { kind: 'gone', path, name: path });
  return { groups, hidden };
}
// Moves one entry of a list up (-1) or down (+1); returns a new list.
export function moved(list, item, d) {
  const i = list.indexOf(item), j = i + d, out = [...list];
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// The folder a search hit sits in, relative to where the search started ('' when it is right there).
export function relFolder(root, path) {
  const rest = path.slice(root.length).replace(/^[\\/]+/, '');
  return rest.includes('/') || rest.includes('\\') ? rest.replace(/[\\/][^\\/]*$/, '') : '';
}

// Where normal Delete sends things: the system's own bin on each platform (see ops.rs).
export const BIN = globalThis.navigator?.userAgent?.includes('Windows') ? 'Recycle Bin' : 'Trash';

// Virtual folders: lists that live at no real path (fs.rs builds them). '' is This PC on Windows.
export const TRASH = 'trash:', RECENT = 'recent:';
const LISTS = new Map([['', 'This PC'], [TRASH, BIN], [RECENT, 'Recent']]);
// A list's display name; undefined for a real folder.
export const placeName = (path) => LISTS.get(path);
export const isFolder = (path) => !!path && !LISTS.has(path);

// "pack.tar.gz" -> "pack": the folder name "Extract to folder" uses; '' when the name is not an archive we extract.
export const archiveStem = (name) => name.match(/^(.+?)\.(zip|7z|rar|tgz|tar(\.(gz|xz|zst|bz2))?)$/i)?.[1] || '';
