import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconFor } from '../ui/icons.js';

test('icon by type, folders win, unknown is a plain file', () => {
  assert.equal(iconFor('Photo.JPG', false), 'image');
  assert.equal(iconFor('book.xlsm', false), 'sheet');
  assert.equal(iconFor('O1234.nc', false), 'code');
  assert.equal(iconFor('stuff.zip', true), 'folder');
  assert.equal(iconFor('README', false), 'file');
  assert.equal(iconFor('.bashrc', false), 'file');
});
