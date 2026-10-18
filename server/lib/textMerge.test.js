import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeText } from './textMerge.js';

test('preserves changes on different lines', () => {
  const base = 'FIRST = 1\nMIDDLE = 2\nLAST = 3\n';
  const current = 'FIRST = 100\nMIDDLE = 2\nLAST = 3\n';
  const incoming = 'FIRST = 1\nMIDDLE = 2\nLAST = 300\n';

  assert.equal(
    mergeText(base, current, incoming),
    'FIRST = 100\nMIDDLE = 2\nLAST = 300\n'
  );
});

test('incoming wins when both change the same line', () => {
  assert.equal(
    mergeText('a\nb\nc', 'a\nLEFT\nc', 'a\nRIGHT\nc'),
    'a\nRIGHT\nc'
  );
});

test('preserves an insertion on a different line', () => {
  assert.equal(
    mergeText('a\nb\nc', 'a\nNEW\nb\nc', 'a\nb\nCHANGED'),
    'a\nNEW\nb\nCHANGED'
  );
});

test('preserves an independent deletion', () => {
  assert.equal(
    mergeText('a\nb\nc\nd', 'a\nc\nd', 'a\nb\nc\nUPDATED'),
    'a\nc\nUPDATED'
  );
});

test('unchanged incoming does not erase current', () => {
  assert.equal(mergeText('a', 'b', 'a'), 'b');
});

test('identical changes do not duplicate text', () => {
  assert.equal(mergeText('a\nb', 'a\nx\nb', 'a\nx\nb'), 'a\nx\nb');
});

test('preserves independent changes immediately beside each other', () => {
  assert.equal(
    mergeText('a\nb\nc', 'A\nb\nc', 'a\nB\nc'),
    'A\nB\nc'
  );
});

test('preserves independent insertions at different positions', () => {
  assert.equal(
    mergeText('a\nb\nc', 'a\nX\nb\nc', 'a\nb\nY\nc'),
    'a\nX\nb\nY\nc'
  );
});

test('preserves two independent deletions', () => {
  assert.equal(
    mergeText('a\nb\nc\nd', 'a\nc\nd', 'a\nb\nc'),
    'a\nc'
  );
});

test('incoming replacement wins against an overlapping deletion', () => {
  assert.equal(
    mergeText('a\nb\nc', 'a\nc', 'a\nB\nc'),
    'a\nB\nc'
  );
});

test('preserves current insertion when incoming edits nearby line', () => {
  assert.equal(
    mergeText('a\nb', 'a\nX\nb', 'a\nB'),
    'a\nX\nB'
  );
});

test('handles empty file becoming nonempty', () => {
  assert.equal(
    mergeText('', '', 'print(1)'),
    'print(1)'
  );
});
