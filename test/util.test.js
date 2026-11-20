import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortEntries, formatSize, formatDate, crumbs, resolveTyped, kindOf, formatMode } from '../ui/util.js';

const e = (name, o = {}) => ({ name, path: `/x/${name}`, dir: false, size: 0, mtime: 0, hidden: false, ...o });

test('folders first, natural name order', () => {
  const r = sortEntries([e('file10'), e('b', { dir: true }), e('file2'), e('A', { dir: true })]);
  assert.deepEqual(r.map((x) => x.name), ['A', 'b', 'file2', 'file10']);
});

test('reverse size keeps folders first', () => {
  const r = sortEntries([e('s', { size: 1 }), e('d', { dir: true }), e('l', { size: 9 })], 'size', true);
  assert.deepEqual(r.map((x) => x.name), ['d', 'l', 's']);
});

test('sizes', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(5 * 1024 ** 3), '5.0 GB');
  assert.equal(formatSize(0, true), '');
});

test('linux crumbs', () => {
  assert.deepEqual(crumbs('/home/matt'), [{ name: '/', path: '/' }, { name: 'home', path: '/home' }, { name: 'matt', path: '/home/matt' }]);
});

test('windows crumbs start at This PC', () => {
  assert.deepEqual(crumbs('C:\\Users\\worktest').map((c) => c.path), ['', 'C:\\', 'C:\\Users', 'C:\\Users\\worktest']);
  assert.deepEqual(crumbs(''), [{ name: 'This PC', path: '' }]);
});

test('typed paths', () => {
  assert.equal(resolveTyped(' ~/Downloads ', '/home/m'), '/home/m/Downloads');
  assert.equal(resolveTyped('d:', 'C:\\Users\\w'), 'd:\\');
  assert.equal(resolveTyped('file:///tmp/a%20b', '/h'), '/tmp/a b');
});

test('kind', () => {
  assert.equal(kindOf(e('a.TXT')), 'TXT file');
  assert.equal(kindOf(e('.bashrc')), 'File');
  assert.equal(kindOf(e('x', { dir: true })), 'Folder');
});

import { sidebarModel, moved } from '../ui/util.js';
test('sidebar: hidden places leave the list but stay known; pins keep their order', () => {
  const places = [{ kind: 'home', path: '/h', name: 'Home' }, { kind: 'drive', path: 'H:\\', name: 'H:' }, { kind: 'drive', path: 'U:\\', name: 'U:' }];
  const m = sidebarModel(['U:\\jobs', '/h/a'], places, { hide: ['U:\\', 'Z:\\'], fold: ['Places'] });
  assert.deepEqual(m.groups.map((g) => [g.name, g.folded, g.items.map((i) => i.path)]),
    [['Pinned', false, ['U:\\jobs', '/h/a']], ['Places', true, ['/h']], ['Drives', false, ['H:\\']]]);
  assert.deepEqual(m.hidden.map((h) => [h.path, h.kind]), [['U:\\', 'drive'], ['Z:\\', 'gone']]); // Z: is disconnected: still hidden
  assert.equal(m.groups[0].items[0].name, 'jobs');
  assert.deepEqual(sidebarModel([], places).hidden, []);
  // Pinned heading stays (first) with no pins; empty Places/Drives still drop out.
  assert.deepEqual(sidebarModel([], [places[1]]).groups.map((g) => [g.name, g.items.length]), [['Pinned', 0], ['Drives', 1]]);
});
test('moved: reorders inside the list and stops at the ends', () => {
  assert.deepEqual(moved(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(moved(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 'x', 1), ['a', 'b', 'c']);
});

test('compact dates: today has time, older years drop it', () => {
  const now = new Date(2026, 10, 17, 12).getTime();
  assert.match(formatDate(new Date(2026, 10, 17, 8, 5).getTime(), now), /^Today /);
  assert.ok(!formatDate(new Date(2026, 8, 7, 8, 5).getTime(), now).includes('2026'));
  assert.ok(formatDate(new Date(2025, 8, 7, 8, 5).getTime(), now).includes('2025'));
  assert.equal(formatDate(0, now), '');
});

import { relFolder } from '../ui/util.js';
test('relFolder: where a search hit sits under the search root', () => {
  assert.equal(relFolder('/home/m', '/home/m/a.txt'), '');
  assert.equal(relFolder('/home/m', '/home/m/x/y/a.txt'), 'x/y');
  assert.equal(relFolder('C:\\Users\\w', 'C:\\Users\\w\\Docs\\a.txt'), 'Docs');
  assert.equal(relFolder('C:\\', 'C:\\a\\b.txt'), 'a');
});

test('permissions', () => {
  assert.equal(formatMode(0o755), 'rwxr-xr-x (755)');
  assert.equal(formatMode(0o640), 'rw-r----- (640)');
});

import { placeName, isFolder, archiveStem, TRASH, RECENT } from '../ui/util.js';
test('virtual folders: named lists, not folders, one crumb', () => {
  assert.deepEqual([placeName(TRASH), placeName(RECENT), placeName(''), placeName('/home/m')], ['Trash', 'Recent', 'This PC', undefined]);
  assert.deepEqual([TRASH, RECENT, '', null, '/home/m', 'C:\\'].map(isFolder), [false, false, false, false, true, true]);
  assert.deepEqual(crumbs(TRASH), [{ name: 'Trash', path: TRASH }]);
  assert.deepEqual(crumbs(RECENT), [{ name: 'Recent', path: RECENT }]);
});
test('archiveStem: the folder name for the archives we extract', () => {
  const names = ['pack.zip', 'a.b.7z', 'x.tar', 'x.tar.gz', 'x.tgz', 'x.tar.xz', 'x.tar.zst', 'x.tar.bz2', 'Old.RAR'];
  assert.deepEqual(names.map(archiveStem), ['pack', 'a.b', 'x', 'x', 'x', 'x', 'x', 'x', 'Old']);
  assert.deepEqual(['notes.txt', 'x.gz', '.zip', 'zip', 'a.zip.txt'].map(archiveStem), ['', '', '', '', '']);
});

import { toUri, toUriList, fromUris, dropRefusal } from '../ui/util.js';
test('file URIs: encode for the clipboard and drags, decode what other apps give', () => {
  assert.equal(toUri('/home/m/a b/é#1%.txt'), 'file:///home/m/a%20b/%C3%A9%231%25.txt');
  assert.equal(toUri('C:\\Users\\m\\a b.txt'), 'file:///C:/Users/m/a%20b.txt');
  assert.equal(toUri('\\\\srv\\share\\f.txt'), 'file://srv/share/f.txt');
  assert.equal(toUriList(['/a', '/b c']), 'file:///a\r\nfile:///b%20c\r\n');
  const paths = ['/home/m/a b/é#1%.txt', '/x'];
  assert.deepEqual(fromUris(toUriList(paths), false), { paths, mv: false });
  // GNOME's payload says cut or copy first; comments and non-file URIs are skipped
  assert.deepEqual(fromUris('cut\nfile:///a%20b\nfile:///c', false), { paths: ['/a b', '/c'], mv: true });
  assert.deepEqual(fromUris('copy\nfile:///a', false), { paths: ['/a'], mv: false });
  assert.deepEqual(fromUris('# note\r\nhttps://x.test/a\r\nfile://localhost/a\r\nfile:/b\r\nfile:///bad%zz\r\n', false).paths, ['/a', '/b']);
  assert.deepEqual(fromUris('just some text', false), { paths: [], mv: false });
  // Windows: real file URIs, and what clip.rs prints (the whole path percent-encoded)
  const win = ['C:\\Users\\m\\a b.txt', '\\\\srv\\share\\f.txt'];
  assert.deepEqual(fromUris(toUriList(win), true).paths, win);
  assert.deepEqual(fromUris('file:C%3A%2FUsers%2Fm%2Fa%20b.txt\r\nfile:%2F%2Fsrv%2Fshare%2Ff.txt\r\n', true).paths, win);
});
test('drops onto itself, into its own subfolder or back where it is are refused', () => {
  assert.match(dropRefusal(['/a/b'], '/a/b', true), /onto itself/);
  assert.match(dropRefusal(['/a/x', '/a/b'], '/a/b/c/', false), /own subfolder/);
  assert.equal(dropRefusal(['/a/b'], '/a/bc', true), '');
  assert.equal(dropRefusal(['/a/b'], '/a', true), 'Already in this folder');
  assert.equal(dropRefusal(['/a/b'], '/a', false), ''); // a copy beside itself is "keep both"
  assert.equal(dropRefusal(['/b'], '/', true), 'Already in this folder');
  assert.equal(dropRefusal(['/a/b', '/c/d'], '/a', true), '');
  assert.match(dropRefusal(['C:\\Docs'], 'c:\\docs\\Sub', true), /own subfolder/);
  assert.equal(dropRefusal(['C:\\a.txt'], 'C:\\', true), 'Already in this folder');
});

test('folder aliases expand, with sub paths, and unknown names give null', async () => {
  const { expandAlias } = await import('../ui/util.js');
  const a = { work: '/srv/work/', jobs: 'U:\\Jobs', net: '\\\\srv\\share' };
  assert.equal(expandAlias('@h', a, '/home/m'), '/home/m');
  assert.equal(expandAlias(' @Work ', a, '/home/m'), '/srv/work/');
  assert.equal(expandAlias('@work/a//b/', a), '/srv/work/a/b');
  assert.equal(expandAlias('@jobs/2026\\may', a), 'U:\\Jobs\\2026\\may');
  assert.equal(expandAlias('@net\\x', a), '\\\\srv\\share\\x');
  assert.equal(expandAlias('@h/x', { h: '/mine' }, '/home/m'), '/mine/x'); // a saved "h" wins over the built-in
  assert.equal(expandAlias('@h/x', {}, 'C:\\Users\\m'), 'C:\\Users\\m\\x');
  for (const t of ['@nope', '@', '@constructor', '/plain']) assert.equal(expandAlias(t, a, '/home/m'), null);
  assert.equal(expandAlias('@h', a, ''), null);
});

test('settings export and import: round trip, partial files merge, wrong shapes are refused with the reason', async () => {
  const { exportSettings, importSettings } = await import('../ui/util.js');
  const state = { preset: 'vim', keys: { open: ['O'] }, pins: ['/a'], side: { hide: ['/x'], fold: ['Drives'], v: 1 }, aliases: { w: '/srv/w' },
    sort: { key: 'date', reverse: true }, hidden: true, dual: false, preview: true, cols: { name: 200 }, split: 0.4, pvw: 300, askBin: true, warnExt: false,
    paths: ['/secret'], tabs: [], focus: 1, manage: true };
  const file = exportSettings(state, 'nord');
  assert.equal(file.inode, 1);
  assert.ok(!('paths' in file.settings) && !('tabs' in file.settings)); // where the panes are is not a setting
  const r = importSettings(JSON.stringify(file));
  assert.equal(r.error, undefined);
  assert.equal(r.theme, 'nord');
  const { paths, tabs, focus, manage, ...kept } = state;
  assert.deepEqual(r.settings, kept);
  assert.deepEqual(r.said, ['key set', 'changed keys', 'pins', 'sidebar', 'aliases', 'view options', 'warnings', 'theme']);
  // only what the file names comes in; a file without "theme" leaves the theme alone, null resets it
  const part = importSettings('{"inode":1,"settings":{"pins":["/p"],"future":42}}');
  assert.deepEqual([part.settings, part.theme, part.said], [{ pins: ['/p'] }, undefined, ['pins']]);
  assert.equal(importSettings('{"inode":1,"settings":{},"theme":null}').theme, null);
  for (const [text, why] of [
    ['{nope', /not valid JSON/], ['[1]', /not an Inode settings file/], ['{"pins":[]}', /not an Inode settings file/],
    ['{"inode":2,"settings":{}}', /version 2/], ['{"inode":1}', /"settings" part is missing/], ['{"inode":1,"settings":{}}', /no settings/],
    ['{"inode":1,"settings":{"pins":"/a"}}', /"pins" should be a list of paths/], ['{"inode":1,"settings":{"pins":["/a"],"hidden":"yes"}}', /"hidden"/],
    ['{"inode":1,"settings":{"aliases":{"Bad Name":"/a"}}}', /"aliases"/], ['{"inode":1,"settings":{"sort":{"key":"colour","reverse":false}}}', /"sort"/],
    ['{"inode":1,"settings":{"keys":{"open":"O"}}}', /"keys"/], ['{"inode":1,"settings":{"side":{"hide":[]}}}', /"side"/],
    ['{"inode":1,"settings":{},"theme":"../x"}', /"theme"/],
  ]) { const bad = importSettings(text); assert.match(bad.error, why); assert.equal(bad.settings, undefined); }
});

// Bulk rename, fuzzy match, recents
const { bulkNames, renameSteps, fuzzyRank, visited, nameError } = await import('../ui/util.js');
const f = (name, dir = false) => ({ name, dir });
const tos = (r) => r.rows.map((x) => x.to);

test('bulk rename: find/replace, prefix, suffix, numbering and case leave the extension alone', () => {
  assert.deepEqual(tos(bulkNames([f('IMG_1.JPG'), f('img_2.jpg')], { find: 'img_', replace: 'pic' }, [], false)), ['pic1.JPG', 'pic2.jpg']);
  assert.deepEqual(tos(bulkNames([f('IMG_1.JPG')], { find: 'img_', replace: 'pic', matchCase: true }, [], false)), ['IMG_1.JPG']);
  assert.deepEqual(tos(bulkNames([f('a.b.txt'), f('dir.d', true)], { prefix: 'x-', suffix: '-y', kase: 'upper' }, [], false)), ['x-A.B-y.txt', 'x-DIR.D-y']);
  assert.deepEqual(tos(bulkNames([f('a.txt'), f('b.txt')], { numPos: 'before', start: 9, step: 2, pad: 3, prefix: ' - ' }, [], false)), ['009 - a.txt', '011 - b.txt']);
  assert.deepEqual(tos(bulkNames([f('a.txt')], { numPos: 'after', suffix: '_' }, [], false)), ['a_1.txt']);
  assert.deepEqual(tos(bulkNames([f('my old_file.TXT')], { kase: 'title' }, [], false)), ['My Old_File.TXT']);
  assert.deepEqual(tos(bulkNames([f('a.txt')], { find: 'txt', replace: 'md', ext: true }, [], false)), ['a.md']);
  assert.deepEqual(tos(bulkNames([f('a.txt')], { find: '.', replace: '$1' }, [], false)), ['a.txt']); // plain text: "." is a dot, not "any character"
});

test('bulk rename: regular expressions, and a bad one is reported', () => {
  assert.deepEqual(tos(bulkNames([f('2026-11-19 scan.pdf')], { find: '^(\\d+)-(\\d+)-(\\d+)', replace: '$3.$2.$1', regex: true }, [], false)), ['19.11.2026 scan.pdf']);
  const bad = bulkNames([f('a')], { find: '(', regex: true }, [], false);
  assert.match(bad.error, /not a valid regular expression/);
  assert.deepEqual(tos(bad), ['a']);
});

test('bulk rename: collisions and invalid names are marked', () => {
  const each = bulkNames([f('a1.txt'), f('a2.txt')], { find: '\\d', replace: '', regex: true }, ['a1.txt', 'a2.txt'], false);
  assert.deepEqual(each.rows.map((r) => !!r.error), [true, true]);
  const taken = bulkNames([f('a.txt'), f('b.txt')], { suffix: '2' }, ['a.txt', 'b.txt', 'a2.txt'], false);
  assert.deepEqual(taken.rows.map((r) => r.error), ['this name is already taken here', '']);
  assert.ok(bulkNames([f('a'), f('b')], { find: 'a', replace: 'x/y' }, [], false).rows[0].error);
  assert.ok(bulkNames([f('a')], { find: 'a', replace: '' }, [], false).rows[0].error);
  // Windows: names that differ only by case collide and "?" is refused; Linux takes both
  assert.ok(bulkNames([f('a'), f('b')], { find: 'b', replace: 'A' }, ['a', 'b'], true).rows[1].error);
  assert.equal(bulkNames([f('a'), f('b')], { find: 'b', replace: 'A' }, ['a', 'b'], false).rows[1].error, '');
  assert.ok(nameError('what?', true)); assert.equal(nameError('what?', false), '');
  // a name freed by the same rename is not a collision
  assert.deepEqual(bulkNames([f('a'), f('b')], { find: 'a', replace: 'c' }, ['a', 'b'], false).rows.map((r) => r.error), ['', '']);
});

// Runs the steps on a pretend folder (Map name -> content); fails if a step would land on a name in use.
const play = (folder, steps) => { for (const [a, b] of steps) { assert.ok(folder.has(a) && !folder.has(b), `${a} -> ${b}`); folder.set(b, folder.get(a)); folder.delete(a); } return Object.fromEntries(folder); };

test('bulk rename order: a swap, a chain and a ring never land on a name in use', () => {
  const swap = renameSteps([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], ['a', 'b'], false);
  assert.equal(swap.length, 3);
  assert.deepEqual(play(new Map([['a', 1], ['b', 2]]), swap), { b: 1, a: 2 });
  const chain = renameSteps([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'k', to: 'k' }], ['a', 'b', 'k'], false);
  assert.deepEqual(chain, [['b', 'c'], ['a', 'b']]);
  const ring = renameSteps([{ from: 'p', to: 'q' }, { from: 'q', to: 'r' }, { from: 'r', to: 'p' }], ['p', 'q', 'r', 'p.inode-tmp'], false);
  assert.deepEqual(play(new Map([['p', 1], ['q', 2], ['r', 3], ['p.inode-tmp', 0]]), ring), { 'p.inode-tmp': 0, q: 1, r: 2, p: 3 });
  // undo = the same steps backwards
  assert.deepEqual(play(new Map([['b', 1], ['a', 2]]), swap.map(([a, b]) => [b, a]).reverse()), { a: 1, b: 2 });
  assert.deepEqual(renameSteps([{ from: 'a', to: 'A' }], ['a'], true), [['a', 'A']]); // Windows: a case-only change
});

test('fuzzy rank: letters in order, best matches first', () => {
  const list = ['Documents /home/m/Documents', 'Downloads /home/m/Downloads', 'mod /srv/mod', '@docs /srv/shared/docs', 'Pictures /home/m/Pictures'];
  assert.deepEqual(fuzzyRank('doc', list), ['@docs /srv/shared/docs', 'Documents /home/m/Documents']);
  assert.deepEqual(fuzzyRank('dl', list), ['Downloads /home/m/Downloads']);
  assert.equal(fuzzyRank('od', list)[0], 'mod /srv/mod'); // inside a word beats scattered letters
  assert.deepEqual(fuzzyRank('pic', [...list, 'epic /x']), ['Pictures /home/m/Pictures', 'epic /x']); // the start of a word beats inside one
  assert.deepEqual(fuzzyRank('zzz', list), []);
  assert.deepEqual(fuzzyRank(' ', list), list);
  assert.deepEqual(fuzzyRank('new fold', [{ t: 'Rename' }, { t: 'New folder' }, { t: 'New file' }], (x) => x.t), [{ t: 'New folder' }]);
});

test('recently visited: newest first, each once, capped at 200', () => {
  assert.deepEqual(visited(['/a', '/b'], '/b'), ['/b', '/a']);
  assert.deepEqual(visited(undefined, '/a'), ['/a']);
  assert.equal(visited(Array.from({ length: 200 }, (_, i) => `/${i}`), '/new').length, 200);
});

import { viewOf, remember, gridStep, shownCols, formatCount, exportSettings, importSettings, VIEW_DEFAULTS } from '../ui/util.js';

test('sort options: natural order, folders first, hidden last, created', () => {
  const names = (r) => r.map((x) => x.name);
  const list = [e('file10'), e('file2'), e('.rc', { hidden: true }), e('d', { dir: true }), e('.git', { dir: true, hidden: true })];
  assert.deepEqual(names(sortEntries(list)), ['.git', 'd', '.rc', 'file2', 'file10']);
  assert.deepEqual(names(sortEntries(list, 'name', false, { natural: false })), ['.git', 'd', '.rc', 'file10', 'file2']);
  assert.deepEqual(names(sortEntries(list, 'name', false, { dirsFirst: false })), ['.git', '.rc', 'd', 'file2', 'file10']);
  assert.deepEqual(names(sortEntries(list, 'name', false, { hiddenLast: true })), ['d', 'file2', 'file10', '.git', '.rc']);
  assert.deepEqual(names(sortEntries(list, 'name', true, { hiddenLast: true })), ['d', 'file10', 'file2', '.git', '.rc']);
  assert.deepEqual(names(sortEntries([e('new', { ctime: 9 }), e('old', { ctime: 1 }), e('none')], 'created')), ['none', 'old', 'new']);
});

test('grid arrows: rows of `cols`, a short last row, the edges', () => {
  // 7 tiles, 3 to a row:  0 1 2 / 3 4 5 / 6
  assert.equal(gridStep(1, 7, 3, 0, 1), 4);
  assert.equal(gridStep(4, 7, 3, 0, -1), 1);
  assert.equal(gridStep(1, 7, 3, 0, -1), 1); // top row stays
  assert.equal(gridStep(5, 7, 3, 0, 1), 6); // nothing right below: the last tile
  assert.equal(gridStep(6, 7, 3, 0, 1), 6); // last row stays
  assert.equal(gridStep(2, 7, 3, 1, 0), 3); // right wraps onto the next row
  assert.equal(gridStep(0, 7, 3, -1, 0), 0);
  assert.equal(gridStep(6, 7, 3, 1, 0), 6);
  // One column is the list: down and up by one, clamped.
  assert.deepEqual([gridStep(0, 3, 1, 0, 1), gridStep(2, 3, 1, 0, 1), gridStep(0, 3, 1, 0, -1)], [1, 2, 0]);
});

test('per-folder views: remembered, else the pane default; capped, newest kept', () => {
  const s = { ...VIEW_DEFAULTS, sort: { key: 'name', reverse: false }, view: [{ grid: false, tile: 1 }, { grid: true, tile: 2 }] };
  s.folders = remember({}, '/pics', { grid: true, tile: 0, key: 'date', reverse: true });
  assert.deepEqual(viewOf(s, 0, '/pics'), { grid: true, tile: 0, sort: { key: 'date', reverse: true } });
  assert.deepEqual(viewOf(s, 0, '/docs'), { grid: false, tile: 1, sort: s.sort });
  assert.deepEqual(viewOf(s, 1, '/docs'), { grid: true, tile: 2, sort: s.sort });
  assert.deepEqual(viewOf({ ...s, perFolder: false }, 0, '/pics'), { grid: false, tile: 1, sort: s.sort });
  // State saved before these settings existed: still a list.
  assert.deepEqual(viewOf({ sort: s.sort }, 1, '/x'), { grid: false, tile: 1, sort: s.sort });
  let f = {};
  for (const p of ['/a', '/b', '/c', '/a']) f = remember(f, p, { grid: p === '/a' }, 2);
  assert.deepEqual(Object.keys(f), ['/c', '/a']);
});

test('columns: the chosen ones in order, Permissions only off Windows; folder counts', () => {
  const s = { ...VIEW_DEFAULTS, colCreated: true, colMode: true, colDate: false };
  assert.deepEqual(shownCols(s, false), ['size', 'kind', 'created', 'mode']);
  assert.deepEqual(shownCols(s, true), ['size', 'kind', 'created']);
  assert.deepEqual([formatCount(0), formatCount(1), formatCount(12), formatCount(null), formatCount(undefined)], ['0 items', '1 item', '12 items', '', '']);
});

test('view settings export and import; remembered folders stay behind', () => {
  const out = exportSettings({ ...VIEW_DEFAULTS, colCreated: true, folders: { '/a': {} } });
  assert.equal(out.settings.colCreated, true);
  assert.ok(!('folders' in out.settings));
  assert.deepEqual(importSettings(JSON.stringify(out)).settings.view, VIEW_DEFAULTS.view);
  assert.match(importSettings(JSON.stringify({ inode: 1, settings: { view: [{ grid: true, tile: 7 }, { grid: false, tile: 1 }] } })).error, /"view"/);
  assert.ok(!importSettings(JSON.stringify({ inode: 1, settings: { sort: { key: 'created', reverse: true } } })).error);
});
