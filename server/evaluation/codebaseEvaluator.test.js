import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseOutput, validateCodebaseTree } from './codebaseEvaluator.js';

const file = (name, content = '') => ({ type: 'file', name, content });

test('accepts a normal codebase', () => {
  assert.equal(
    validateCodebaseTree({
      type: 'directory',
      children: [
        file('main.py', 'def main():\n    pass\n'),
        { type: 'directory', name: 'lib', children: [file('util.py')] },
      ],
    }),
    null
  );
});

test('rejects path traversal, duplicates and bad types', () => {
  const tree = (children) => ({ type: 'directory', children });

  assert.match(validateCodebaseTree(tree([file('../x')])), /Invalid/);
  assert.match(validateCodebaseTree(tree([file('a/b')])), /Invalid/);
  assert.match(
    validateCodebaseTree(tree([file('Main.py'), file('main.py')])),
    /Duplicate/
  );
  assert.match(
    validateCodebaseTree(tree([{ type: 'link', name: 'x' }])),
    /Invalid node type/
  );
  assert.match(
    validateCodebaseTree(tree([{ type: 'file', name: 'x', content: 5 }])),
    /must be text/
  );
  assert.match(validateCodebaseTree({}), /valid codebase/);
});

test('output comparison ignores CRLF and trailing whitespace', () => {
  assert.equal(normaliseOutput('1 2  \r\n3\r\n\r\n'), '1 2\n3');
  assert.equal(normaliseOutput(undefined), '');
  assert.notEqual(normaliseOutput(' 1'), normaliseOutput('1'));
});
