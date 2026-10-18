import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCaretPosition, mapSelection } from './caretPosition.js';

test('insertion before caret moves caret forward', () => {
  assert.equal(mapCaretPosition('hello world', 'Xhello world', 5), 6);
});

test('deletion before caret moves caret backward', () => {
  assert.equal(mapCaretPosition('Xhello world', 'hello world', 6), 5);
});

test('insertion after caret does not move caret', () => {
  assert.equal(mapCaretPosition('hello', 'hello!', 2), 2);
});

test('deletion after caret does not move caret', () => {
  assert.equal(mapCaretPosition('hello!', 'hello', 2), 2);
});

test('replacement containing caret moves caret to replacement end', () => {
  assert.equal(mapCaretPosition('abcdef', 'abXYZef', 3), 5);
});

test('selection adjusts when text is inserted before it', () => {
  assert.deepEqual(
    mapSelection('hello world', 'Xhello world', { start: 6, end: 11 }),
    { start: 7, end: 12 }
  );
});

test('caret remains within text bounds', () => {
  assert.equal(mapCaretPosition('abcdef', '', 6), 0);
});

test('unchanged text preserves caret', () => {
  assert.equal(mapCaretPosition('hello', 'hello', 3), 3);
});
