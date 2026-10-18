import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomToCodebase } from './roomCodebase.js';
import { validateCodebaseTree } from '../evaluation/codebaseEvaluator.js';

const tree = {
  id: 'root',
  name: 'Code',
  type: 'directory',
  children: [
    { id: '1', name: 'main.py', type: 'file' },
    {
      id: '2',
      name: 'lib',
      type: 'directory',
      children: [{ id: '3', name: 'util.py', type: 'file' }],
    },
  ],
};

test('builds the grader tree from a live room (files are { code } records)', () => {
  const files = new Map([
    ['main.py', { code: 'print(1)' }],
    ['lib/util.py', { code: 'X = 2' }],
  ]);
  const codebase = roomToCodebase(tree, files);

  assert.deepEqual(codebase, {
    type: 'directory',
    children: [
      { type: 'file', name: 'main.py', content: 'print(1)' },
      {
        type: 'directory',
        name: 'lib',
        children: [{ type: 'file', name: 'util.py', content: 'X = 2' }],
      },
    ],
  });
  assert.equal(validateCodebaseTree(codebase), null);
});

test('also accepts saved rooms (plain objects of strings) and missing files', () => {
  const codebase = roomToCodebase(tree, { 'main.py': 'pass' });

  assert.equal(codebase.children[0].content, 'pass');
  // A file with no saved text is empty rather than an error
  assert.equal(codebase.children[1].children[0].content, '');
});
