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
export const WIN = !!globalThis.navigator?.userAgent?.includes('Windows');
export const BIN = WIN ? 'Recycle Bin' : 'Trash';

// Virtual folders: lists that live at no real path (fs.rs builds them). '' is This PC on Windows.
export const TRASH = 'trash:', RECENT = 'recent:';
const LISTS = new Map([['', 'This PC'], [TRASH, BIN], [RECENT, 'Recent']]);
// A list's display name; undefined for a real folder.
export const placeName = (path) => LISTS.get(path);
export const isFolder = (path) => !!path && !LISTS.has(path);

// "pack.tar.gz" -> "pack": the folder name "Extract to folder" uses; '' when the name is not an archive we extract.
export const archiveStem = (name) => name.match(/^(.+?)\.(zip|7z|rar|tgz|tar(\.(gz|xz|zst|bz2))?)$/i)?.[1] || '';

// Files as text/uri-list: percent-encoded file:// URIs, one per CRLF line. Other apps read this from the clipboard and from drags.
export const toUri = (p) => `file://${/^[\\/]/.test(p) ? '' : '/'}${p.replace(/^\\\\/, '').split(/[\\/]/).map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`;
export const toUriList = (paths) => paths.map((p) => `${toUri(p)}\r\n`).join('');

// The reverse: { paths, mv } from a text/uri-list or an x-special/gnome-copied-files payload (its first line says
// "cut" or "copy"). Anything that is not a file:// URI is skipped. `win` turns drive and \\server URIs into Windows paths.
export function fromUris(text, win = WIN) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const paths = lines.filter((l) => /^file:/i.test(l)).map((l) => {
    let rest;
    try { rest = decodeURIComponent(l.slice(5)); } catch { return null; }
    const drive = win && rest.match(/^\/*([A-Za-z]:\/.*)$/);
    if (drive) return drive[1].replace(/\//g, '\\');
    const m = rest.match(/^\/\/([^/]*)(\/.*)$/); // //host/path; no host (or localhost) = this machine
    if (!m) return rest.startsWith('/') && !rest.startsWith('//') ? rest : null;
    return win && m[1] && m[1] !== 'localhost' ? `\\\\${m[1]}${m[2].replace(/\//g, '\\')}` : m[2];
  }).filter(Boolean);
  return { paths, mv: lines[0] === 'cut' };
}

// Why `sources` cannot be dropped into the folder `dest` ('' = they can). `mv` = the drop would move them.
export function dropRefusal(sources, dest, mv) {
  const fold = isWinPath(dest) ? (s) => s.toLowerCase() : (s) => s;
  const norm = (p) => fold(p.replace(/[\\/]+$/, '')), d = norm(dest);
  for (const s of sources.map(norm)) {
    if (s === d) return 'A folder cannot be dropped onto itself';
    if (d.startsWith(s) && /[\\/]/.test(d[s.length])) return 'A folder cannot be dropped into its own subfolder';
  }
  return mv && sources.every((s) => norm(norm(s).replace(/[\\/][^\\/]*$/, '')) === d) ? 'Already in this folder' : '';
}

// Folder aliases: "@name" or "@name/sub/path" typed in the path bar -> the folder it stands for; null when no alias
// has that name. "@h" is home unless the user saved an "h" of their own. Names are lower-case letters, digits, - and _.
export const ALIAS = /^[a-z0-9_-]+$/;
export function expandAlias(text, aliases = {}, home = '') {
  const m = text.trim().match(/^@([^\\/]*)(?:[\\/]+(.*))?$/);
  if (!m) return null;
  const all = { h: home, ...aliases }, k = m[1].toLowerCase(), base = Object.hasOwn(all, k) ? all[k] : '';
  if (!base || !m[2]) return base || null;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${m[2].split(/[\\/]+/).filter(Boolean).join(sep)}`;
}

// Settings file (Export / Import settings): { inode: 1, settings: { ... }, theme }.
// Each setting: [check, what it should be (for the refusal), what the user calls it (for "Imported ...")].
const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const obj = (v, ok = () => true) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(ok);
const bool = (v) => typeof v === 'boolean';
const SETTINGS = {
  preset: [(v) => typeof v === 'string', 'the name of a key set', 'key set'],
  keys: [(v) => obj(v, strs), 'a list of keys for each action', 'changed keys'],
  pins: [strs, 'a list of paths', 'pins'],
  side: [(v) => obj(v) && strs(v.hide) && strs(v.fold), 'the hidden and folded sidebar lists', 'sidebar'],
  aliases: [(v) => obj(v, (x) => typeof x === 'string' && !!x) && Object.keys(v).every((k) => ALIAS.test(k)), 'a folder for each alias name', 'aliases'],
  sort: [(v) => obj(v) && ['name', 'size', 'date', 'kind'].includes(v.key) && bool(v.reverse), 'a sort column and direction', 'view options'],
  hidden: [bool, 'true or false', 'view options'],
  dual: [bool, 'true or false', 'view options'],
  preview: [bool, 'true or false', 'view options'],
  cols: [(v) => obj(v, Number.isFinite), 'column widths', 'view options'],
  split: [Number.isFinite, 'a number', 'view options'],
  pvw: [Number.isFinite, 'a number', 'view options'],
  askBin: [bool, 'true or false', 'warnings'],
  warnExt: [bool, 'true or false', 'warnings'],
};
// `theme` = this app's own theme choice (null = it follows the suite / the default).
export const exportSettings = (state, theme = null) => ({ inode: 1, settings: Object.fromEntries(Object.keys(SETTINGS).filter((k) => k in state).map((k) => [k, state[k]])), theme });
// Checks a settings file's text. Wrong shape: { error } (the reason), nothing to apply. Otherwise { settings, theme, said }:
// `settings` goes over the saved state with Object.assign (what the file does not name stays as it is), `theme` is
// undefined when the file has none, `said` names what came in.
export function importSettings(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { error: 'it is not valid JSON' }; }
  if (!obj(j) || !('inode' in j)) return { error: 'it is not an Inode settings file' };
  if (j.inode !== 1) return { error: `it is settings version ${j.inode}; this Inode reads version 1` };
  if (!obj(j.settings)) return { error: 'its "settings" part is missing' };
  if (j.theme != null && !(typeof j.theme === 'string' && /^[a-z0-9-]{1,40}$/.test(j.theme))) return { error: '"theme" should be a theme name' };
  const settings = {}, said = new Set();
  for (const [k, [ok, want, name]] of Object.entries(SETTINGS)) {
    if (!(k in j.settings)) continue;
    if (!ok(j.settings[k])) return { error: `"${k}" should be ${want}` };
    settings[k] = j.settings[k]; said.add(name);
  }
  if (settings.side) settings.side = { hide: settings.side.hide, fold: settings.side.fold, v: 1 };
  if ('theme' in j) said.add('theme');
  if (!said.size) return { error: 'it holds no settings' };
  return { settings, theme: j.theme, said: [...said] };
}
