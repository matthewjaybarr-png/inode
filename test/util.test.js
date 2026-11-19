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
