// Linux desktop pieces: the file chooser's filters and accept rules (pick.js), network addresses (net.js, util.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { globTest, fits, choose } from '../ui/pick.js';
import { needs, shownAddress } from '../ui/net.js';
import { isAddress, isFolder, sidebarModel, resolveTyped } from '../ui/util.js';

test('file chooser: globs match file names, whatever the letter case', () => {
  const hit = (g, n) => globTest(g).test(n);
  assert.deepEqual(['a.txt', 'A.TXT', 'a.txt.bak', 'atxt'].map((n) => hit('*.txt', n)), [true, true, false, false]);
  assert.deepEqual(['x.jpg', 'x.JPG', 'x.jpeg'].map((n) => hit('*.[jJ][pP][gG]', n)), [true, true, false]);
  assert.deepEqual(['a1.c', 'ab.c', 'a.c'].map((n) => hit('a?.c', n)), [true, true, false]);
  assert.deepEqual(['a.c', 'b.c', 'c.c'].map((n) => hit('[!ab].c', n)), [false, false, true]);
  assert.ok(hit('*', 'anything') && hit('report (1)+$.pdf', 'report (1)+$.pdf') && !hit('report (1)+$.pdf', 'report 1.pdf'));
  assert.ok(hit('[', '[') && !hit('[', 'x')); // an unclosed bracket is just a character
  const images = { name: 'Images', globs: ['*.png', '*.jpg'] };
  assert.deepEqual(['a.PNG', 'b.jpg', 'c.txt'].map((n) => fits(images, n)), [true, true, false]);
  assert.ok(fits(undefined, 'x') && fits({ name: 'All', globs: [] }, 'x')); // no filter, or one that names nothing, shows everything
});

const file = (name, dir = false) => ({ name, path: `/d/${name}`, dir });
const at = (o) => ({ path: '/d', entries: [file('a.txt'), file('b.txt'), file('sub', true)], selected: [], cursor: null, name: '', ...o });

test('file chooser: Open answers with files, and opens a folder instead of answering with it', () => {
  const one = { mode: 'open', multiple: false, directory: false }, many = { ...one, multiple: true };
  assert.deepEqual(choose(one, at({ cursor: file('a.txt') })), { paths: ['/d/a.txt'] });
  assert.deepEqual(choose(one, at({ cursor: file('sub', true) })), { go: '/d/sub' });
  assert.deepEqual(choose(one, at({ selected: [file('sub', true)], cursor: file('a.txt') })), { go: '/d/sub' });
  assert.ok(choose(one, at({})).say && choose(one, at({ selected: [file('a.txt'), file('b.txt')] })).say);
  assert.deepEqual(choose(many, at({ selected: [file('a.txt'), file('sub', true), file('b.txt')] })), { paths: ['/d/a.txt', '/d/b.txt'] });
  assert.ok(choose(one, at({ path: 'trash:', cursor: file('a.txt') })).say);
  assert.deepEqual(choose(one, at({ path: 'recent:', cursor: { name: 'r.txt', path: '/x/r.txt', dir: false } })), { paths: ['/x/r.txt'] });
});

test('file chooser: a folder request answers with the selected folder, else the one shown', () => {
  const dir = { mode: 'open', multiple: false, directory: true };
  assert.deepEqual(choose(dir, at({ cursor: file('sub', true) })), { paths: ['/d'] }); // the cursor alone selects nothing
  assert.deepEqual(choose(dir, at({ selected: [file('sub', true)] })), { paths: ['/d/sub'] });
  assert.deepEqual(choose(dir, at({ selected: [file('a.txt')] })), { paths: ['/d'] });
  assert.ok(choose(dir, at({ selected: [file('sub', true), file('s2', true)] })).say);
  assert.deepEqual(choose({ ...dir, multiple: true }, at({ selected: [file('sub', true), file('s2', true)] })), { paths: ['/d/sub', '/d/s2'] });
  assert.ok(choose(dir, at({ path: 'recent:' })).say);
});

test('file chooser: Save needs a name, asks before replacing, and opens a folder typed as the name', () => {
  const save = { mode: 'save' };
  assert.deepEqual(choose(save, at({ name: ' new.txt ' })), { paths: ['/d/new.txt'], replace: [] });
  assert.deepEqual(choose(save, at({ name: 'a.txt' })), { paths: ['/d/a.txt'], replace: ['a.txt'] });
  assert.deepEqual(choose(save, at({ name: 'sub' })), { go: '/d/sub' });
  assert.deepEqual(choose(save, at({ path: '/', entries: [], name: 'x' })), { paths: ['/x'], replace: [] });
  for (const name of ['', '  ', 'a/b', '..']) assert.ok(choose(save, at({ name })).say, name);
  assert.ok(choose(save, at({ path: 'trash:', name: 'x' })).say);
  assert.deepEqual(choose({ mode: 'saveFiles', directory: true, files: ['a.txt', 'z.txt'] }, at({})), { paths: ['/d/a.txt', '/d/z.txt'], replace: ['a.txt'] });
});

test('network: addresses are told from folders, and a typed one reaches the pane as it is', () => {
  for (const a of ['smb://nas/docs', 'sftp://kim@box/srv', 'SMB://NAS/x', 'mtp://Pixel_6/', 'davs://cloud.example/dav', 'connect:', 'luks:/dev/sdb1']) assert.ok(isAddress(a) && !isFolder(a), a);
  for (const p of ['/home/m', 'C:\\Users', 'C:/Users', '\\\\server\\share', '/odd/smb://name', '', null, 'trash:', 'connect:x']) assert.ok(!isAddress(p), String(p));
  assert.equal(resolveTyped(' smb://nas/docs ', '/home/m'), 'smb://nas/docs');
});

test('network: what the backend asks for is understood, and a typed password is never shown again', () => {
  assert.deepEqual(needs('auth:user:matt'), { user: 'matt' });
  assert.deepEqual(needs('auth:user:'), { user: '' });
  assert.deepEqual(needs('auth:password'), {});
  assert.deepEqual(needs('trust:Can’t verify the identity of “box”.'), { trust: 'Can’t verify the identity of “box”.' });
  assert.equal(needs('Failed to mount Windows share: Connection refused'), null);
  assert.equal(shownAddress('ftp://kim:secret@box/pub'), 'ftp://kim@box/pub');
  assert.equal(shownAddress('sftp://kim@box:2222/srv'), 'sftp://kim@box:2222/srv');
  assert.equal(shownAddress('smb://nas/docs'), 'smb://nas/docs');
});

test('sidebar: Network is its own group; phones and locked drives sit under Drives', () => {
  const places = [{ kind: 'home', path: '/h', name: 'Home' }, { kind: 'drive', path: '/', name: 'File System' }, { kind: 'connect', path: 'connect:', name: 'Connect to server…' },
    { kind: 'network', path: '/run/user/1000/gvfs/smb-share:server=nas,share=docs', name: 'docs on nas' }, { kind: 'phone', path: 'mtp://Pixel_6/', name: 'Pixel 6' }, { kind: 'locked', path: 'luks:/dev/sdb1', name: 'Vault' }];
  assert.deepEqual(sidebarModel([], places).groups.map((g) => [g.name, g.items.map((p) => p.name)]),
    [['Pinned', []], ['Places', ['Home']], ['Drives', ['File System', 'Pixel 6', 'Vault']], ['Network', ['Connect to server…', 'docs on nas']]]);
});
