// Pure helpers (no DOM, no Tauri) so node --test can cover them.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const plain = new Intl.Collator(undefined, { sensitivity: 'base' }); // natural order off: file10 before file2

export const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || p === '';

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// By key; ties fall back to name so the order is stable. Options (the saved view settings, all optional):
// dirsFirst (default on), natural = numbers in names count as numbers (default on), hiddenLast (default off).
export function sortEntries(entries, key = 'name', reverse = false, { dirsFirst = true, natural = true, hiddenLast = false } = {}) {
  const c = natural ? collator : plain, name = (a, b) => c.compare(a.name, b.name);
  const by = {
    size: (a, b) => a.size - b.size,
    date: (a, b) => a.mtime - b.mtime,
    kind: (a, b) => c.compare(extOf(a.name), extOf(b.name)),
    created: (a, b) => (a.ctime || 0) - (b.ctime || 0),
    mode: (a, b) => (a.mode || 0) - (b.mode || 0),
  }[key] || name;
  const dir = reverse ? -1 : 1;
  return [...entries].sort((a, b) => (hiddenLast && a.hidden - b.hidden) || (dirsFirst && b.dir - a.dir) || (by(a, b) * dir) || name(a, b));
}

export function formatSize(n, dir) {
  if (dir) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

// A folder's Size cell: "12 items"; nothing while it is being counted or when it cannot be read.
export const formatCount = (n) => (n == null ? '' : `${n} item${n === 1 ? '' : 's'}`);

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
// Linux adds a Network group (mounted shares, "Connect to server…") and, under Drives, phones and locked encrypted drives.
const GROUP = (kind) => (kind === 'network' || kind === 'connect' ? 'Network' : ['drive', 'computer', 'phone', 'locked', 'vault'].includes(kind) ? 'Drives' : 'Places');
export function sidebarModel(pins, places, side = {}) {
  const hide = new Set(side.hide || []), fold = new Set(side.fold || []);
  const groups = [
    { name: 'Pinned', items: pins.map((path) => ({ kind: 'pin', path, name: path.split(/[\\/]/).filter(Boolean).pop() || path })) },
    ...['Places', 'Drives', 'Network'].map((name) => ({ name, items: places.filter((p) => GROUP(p.kind) === name && !hide.has(p.path)) })),
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
// "tags:red" lists everything tagged red (tags.rs); the seven colours, in menu order.
export const TAGS = 'tags:', TAG_COLOURS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'];
export const placeName = (path) => LISTS.get(path) ?? (path?.startsWith(TAGS) ? `Tagged ${path.slice(TAGS.length)}` : undefined);
// Not a folder yet: a network address (smb://server/share), a locked drive (luks:/dev/sdb1) or the "Connect to
// server…" row (connect:). Opening one mounts it first (net.js), and the folder it becomes is what a pane shows.
export const isAddress = (path) => /^(connect:$|luks:\/|vault:\/|[a-z][a-z0-9+.-]+:\/\/)/i.test(path || '');
export const isFolder = (path) => !!path && placeName(path) === undefined && !isAddress(path);

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
  sort: [(v) => obj(v) && ['name', 'size', 'date', 'kind', 'created', 'mode'].includes(v.key) && bool(v.reverse), 'a sort column and direction', 'view options'],
  hidden: [bool, 'true or false', 'view options'],
  dual: [bool, 'true or false', 'view options'],
  preview: [bool, 'true or false', 'view options'],
  cols: [(v) => obj(v, Number.isFinite), 'column widths', 'view options'],
  split: [Number.isFinite, 'a number', 'view options'],
  pvw: [Number.isFinite, 'a number', 'view options'],
  askBin: [bool, 'true or false', 'warnings'],
  warnExt: [bool, 'true or false', 'warnings'],
  restoreTabs: [bool, 'true or false', 'view options'],
  view: [(v) => Array.isArray(v) && v.length === 2 && v.every((x) => obj(x) && bool(x.grid) && [0, 1, 2].includes(x.tile)), 'list or grid and a tile size for each pane', 'view options'],
  ...Object.fromEntries(['colSize', 'colDate', 'colKind', 'colCreated', 'colMode', 'dirsFirst', 'natural', 'hiddenLast', 'perFolder'].map((k) => [k, [bool, 'true or false', 'view options']])),
  // `folders` (the views remembered per folder) stays out: it is this machine's paths, and 500 of them would
  // pass the 64 KB the import reads.
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

// Why a name cannot be used ('' = it can); the same rules as check_name in ops.rs, which still has the last word.
export function nameError(name, win = WIN) {
  if (!name.trim() || name === '.' || name === '..' || (win ? /[\\/:*?"<>|\0]/ : /[/\0]/).test(name)) return 'not a valid name';
  return win && /[. ]$/.test(name) ? 'Windows names cannot end with a dot or space' : '';
}

// Bulk rename: the new name of each item ({ name, dir }), in list order. `o` = { find, replace, regex, matchCase,
// prefix, suffix, numPos ('' | 'before' | 'after'), start, step, pad, kase ('keep' | 'lower' | 'upper' | 'title'), ext }.
// A file's extension is left alone unless o.ext. The number goes at the very start or end, outside prefix and suffix,
// so a prefix of " - " gives "01 - name". `others` = every name in the folder; `win` = names compare without case.
// Returns { rows: [{ from, to, error }], error }: a row's error says why it cannot be renamed, `error` why Find is bad.
export function bulkNames(items, o = {}, others = [], win = WIN) {
  const fold = (s) => (win ? s.toLowerCase() : s);
  let re = null, error = '';
  if (o.find) {
    try { re = new RegExp(o.regex ? o.find : o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.matchCase ? 'g' : 'gi'); }
    catch (e) { error = `Find is not a valid regular expression: ${e.message}`; }
  }
  const kase = { lower: (s) => s.toLowerCase(), upper: (s) => s.toUpperCase(), title: (s) => s.toLowerCase().replace(/(^|[\s._-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) }[o.kase] || ((s) => s);
  const start = Number.isFinite(parseInt(o.start, 10)) ? parseInt(o.start, 10) : 1, step = parseInt(o.step, 10) || 1;
  const rows = items.map((it, i) => {
    const dot = it.dir || o.ext ? -1 : it.name.lastIndexOf('.');
    const stem = dot > 0 ? it.name.slice(0, dot) : it.name, ext = dot > 0 ? it.name.slice(dot) : '';
    const num = o.numPos ? String(start + i * step).padStart(parseInt(o.pad, 10) || 1, '0') : '';
    // Plain text: the replacement is taken literally ("$1" stays "$1"); a regular expression may use $1, $2 …
    const s = re ? stem.replace(re, o.regex ? o.replace || '' : () => o.replace || '') : stem;
    return { from: it.name, to: `${o.numPos === 'before' ? num : ''}${o.prefix || ''}${kase(s)}${o.suffix || ''}${o.numPos === 'after' ? num : ''}${ext}`, error: '' };
  });
  const count = new Map(), mine = new Set(items.map((it) => fold(it.name)));
  for (const r of rows) count.set(fold(r.to), (count.get(fold(r.to)) || 0) + 1);
  const taken = new Set(others.map(fold).filter((n) => !mine.has(n)));
  for (const r of rows) {
    r.error = (r.to !== r.from && nameError(r.to, win)) || (count.get(fold(r.to)) > 1 ? 'two items would get this name' : taken.has(fold(r.to)) ? 'this name is already taken here' : '');
  }
  return { rows, error };
}

// The order to do a bulk rename in: [from, to] steps where no step lands on a name still in use. A chain (a→b while
// b→c) runs from its free end; a swap or a ring first parks one item on a temporary name. `taken` = names in the folder.
export function renameSteps(rows, taken = [], win = WIN) {
  const fold = (s) => (win ? s.toLowerCase() : s);
  const todo = rows.filter((r) => r.from !== r.to).map((r) => [r.from, r.to]);
  const used = new Set([...taken, ...todo.flat()].map(fold)), steps = [];
  while (todo.length) {
    // Free = no other waiting item still holds the target name (a case-only change holds its own).
    const i = todo.findIndex(([f, t]) => !todo.some(([g]) => g !== f && fold(g) === fold(t)));
    if (i >= 0) { steps.push(...todo.splice(i, 1)); continue; }
    let tmp = `${todo[0][0]}.inode-tmp`;
    while (used.has(fold(tmp))) tmp += '~';
    used.add(fold(tmp)); steps.push([todo[0][0], tmp]); todo[0] = [tmp, todo[0][1]];
  }
  return steps;
}

// Fuzzy filter for the jump box and the command palette: keeps the items whose text holds the typed letters in order,
// best first: a hit at the start of a word, then a hit inside a word, then scattered letters (tighter is better);
// ties go to the shorter text, then the original order. Nothing typed = everything, as given.
export function fuzzyRank(query, items, text = (x) => x) {
  const q = query.trim().toLowerCase(), letters = q.replace(/\s+/g, '');
  if (!q) return [...items];
  const out = [];
  items.forEach((it, n) => {
    const t = text(it).toLowerCase(), at = t.indexOf(q);
    let score;
    if (at >= 0) score = at === 0 || /[^a-z0-9]/.test(t[at - 1]) ? 0 : 100 + at;
    else {
      let i = -1, first = -1;
      for (const c of letters) { i = t.indexOf(c, i + 1); if (i < 0) return; if (first < 0) first = i; }
      score = 1000 + i - first;
    }
    out.push([score, t.length, n, it]);
  });
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map((x) => x[3]);
}

// Recently visited folders: `path` moves to the front, each folder once, the last 200 kept.
export const visited = (list, path) => [path, ...(list || []).filter((p) => p !== path)].slice(0, 200);
// View settings added in 0.6: each pane's default (list or grid, tile size 0-2), which columns show, sort
// options, and `folders` = the view remembered per folder path (oldest first).
export const VIEW_DEFAULTS = { view: [{ grid: false, tile: 1 }, { grid: false, tile: 1 }], colSize: true, colDate: true, colKind: true, colCreated: false, colMode: false, dirsFirst: true, natural: true, hiddenLast: false, perFolder: true, folders: {} };

// The optional list columns: key -> [its saved setting, heading, default width in px]. Name always shows.
export const COLUMNS = { size: ['colSize', 'Size', 80], date: ['colDate', 'Modified', 130], kind: ['colKind', 'Type', 100], created: ['colCreated', 'Created', 130], mode: ['colMode', 'Permissions', 130] };
// The ones switched on, in order. Permissions is a Linux column: Windows listings carry none.
export const shownCols = (state, win = WIN) => Object.keys(COLUMNS).filter((k) => state[COLUMNS[k][0]] && !(win && k === 'mode'));

// The view a pane shows `path` with: the one remembered for that folder, else the pane's default.
export function viewOf(state, side, path) {
  const f = state.perFolder && state.folders?.[path], d = state.view?.[side] || VIEW_DEFAULTS.view[0];
  return f ? { grid: !!f.grid, tile: f.tile ?? 1, sort: { key: f.key, reverse: !!f.reverse } } : { grid: !!d.grid, tile: d.tile ?? 1, sort: state.sort };
}
// `folders` with `view` remembered for `path` as the newest; the oldest drop out past `cap`.
export function remember(folders, path, view, cap = 500) {
  const rest = Object.entries(folders).filter(([k]) => k !== path);
  return Object.fromEntries([...rest.slice(Math.max(0, rest.length - cap + 1)), [path, view]]);
}

// Grid cursor: from tile i of n, laid out `cols` to a row, one step sideways (dx) or one row (dy). Down from
// the row above a short last row lands on the last tile; cols 1 is the plain list.
export function gridStep(i, n, cols, dx, dy) {
  if (dx) return Math.max(0, Math.min(n - 1, i + dx));
  const j = i + dy * cols;
  if (j < 0) return i;
  if (j >= n) return Math.floor(i / cols) < Math.floor((n - 1) / cols) ? n - 1 : i;
  return j;
}

export const IMAGES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];

// Custom actions (actions.rs reads the files): which of them fit a selection, with the menu text for each.
// An action shows only when every selected item fits it: not a folder if it says `directories = false`, inside
// one of its `under` folders, and of one of its kinds or extensions (none listed = anything).
// shortcut: a file's kind is told from its extension, and only by family (image/*, video/*, audio/*, text/*)
// plus application/pdf; an exact type such as image/jpeg needs the action's `extensions`. Ask the desktop's
// type database if actions ever need more.
const FAMILY = {
  image: [...IMAGES, 'heic', 'heif', 'tif', 'tiff', 'raw', 'cr2', 'nef', 'arw', 'dng'],
  video: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', 'flv', '3gp', 'ogv'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'aiff'],
  text: ['txt', 'md', 'log', 'csv', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'py', 'rs', 'c', 'h', 'cpp', 'sh', 'toml', 'yaml', 'yml', 'ini', 'conf', 'nc', 'tap', 'min', 'eia'],
};
export function actionsFor(actions, entries, win = WIN) {
  const low = (s) => (win ? s.toLowerCase() : s), n = entries.length;
  const fits = (a, e) => {
    if (e.dir && a.directories === false) return false;
    if (a.under?.length && !a.under.some((root) => { const r = low(root.replace(/[\\/]+$/, '')), p = low(e.path); return p === r || (p.startsWith(r) && /[\\/]/.test(p[r.length])); })) return false;
    const kinds = a.mimetypes || [], exts = a.extensions || [];
    if (!kinds.length && !exts.length) return true;
    const x = e.dir ? '' : extOf(e.name), family = e.dir ? 'inode' : Object.keys(FAMILY).find((k) => FAMILY[k].includes(x));
    return kinds.some((k) => k === '*/*' || k === `${family}/*` || (e.dir && k === 'inode/directory') || (k === 'application/pdf' && x === 'pdf'))
      || (!!x && exts.some((s) => s.replace(/^\./, '').toLowerCase() === x));
  };
  return n ? actions.filter((a) => entries.every((e) => fits(a, e))).map((a) => ({ a, label: n > 1 && a.plural ? a.plural.replaceAll('%n', n) : a.name })) : [];
}
