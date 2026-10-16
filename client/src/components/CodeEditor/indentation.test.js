import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextLineIndentation, shiftLines } from './indentation.js';

test('the line after a colon is one level deeper', () => {
  assert.equal(nextLineIndentation('def main():'), '    ');
  assert.equal(nextLineIndentation('    for i in range(3):'), '        ');
  assert.equal(nextLineIndentation('    if x:  # check it'), '        ');
});

test('the body of else/elif/except/finally is deeper than the keyword', () => {
  // Pressing Enter after "    else:" used to drop back to column 0
  assert.equal(nextLineIndentation('    else:'), '        ');
  assert.equal(nextLineIndentation('    elif y > 2:'), '        ');
  assert.equal(nextLineIndentation('    except ValueError:'), '        ');
  assert.equal(nextLineIndentation('    finally:'), '        ');
});

test('ordinary lines keep their indentation', () => {
  assert.equal(nextLineIndentation('    x = 1'), '    ');
  assert.equal(nextLineIndentation('x = 1'), '');
  assert.equal(nextLineIndentation('\ty = 2'), '\t');
});

test('the line after return/pass/break/continue/raise is shallower', () => {
  assert.equal(nextLineIndentation('        return x'), '    ');
  assert.equal(nextLineIndentation('    pass'), '');
  assert.equal(nextLineIndentation('\t\tbreak'), '\t');
  // Never below column 0
  assert.equal(nextLineIndentation('return 1'), '');
});

test('Tab on a selection indents the lines instead of replacing the text', () => {
  const text = 'a = 1\nb = 2\nc = 3';
  const result = shiftLines(text, 0, 11, false);

  assert.equal(result.value, '    a = 1\n    b = 2\nc = 3');
  assert.equal(result.selectionStart, 0);
  assert.equal(result.selectionEnd, 19);
});

test('the selection keeps covering the same text after indenting', () => {
  const text = 'x = 1\ny = 2';
  // "= 1\ny =" selected
  const result = shiftLines(text, 2, 9, false);

  assert.equal(result.value, '    x = 1\n    y = 2');
  assert.equal(
    result.value.slice(result.selectionStart, result.selectionEnd),
    '= 1\n    y ='
  );
});

test('indenting skips blank lines and a trailing newline in the selection', () => {
  const text = 'a\n\nb\nc';
  const result = shiftLines(text, 0, 4, false);

  // The selection ends just after "b\n", so "c" is not touched
  assert.equal(result.value, '    a\n\n    b\nc');
});

test('Shift+Tab removes up to one indent level from each line', () => {
  const text = '        a\n    b\n  c\nd';
  const result = shiftLines(text, 0, text.length, true);

  assert.equal(result.value, '    a\nb\nc\nd');
});

test('Shift+Tab handles tabs and does not move the caret above its line', () => {
  const text = 'if x:\n\ty = 1';
  // Caret just after the tab
  const result = shiftLines(text, 7, 7, true);

  assert.equal(result.value, 'if x:\ny = 1');
  assert.equal(result.selectionStart, 6);
  assert.equal(result.selectionEnd, 6);
});
