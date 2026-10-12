import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyOp,
  compose,
  diffToOp,
  transform,
  transformIndex,
} from './textOp.js';

const rand = (n) => Math.floor(Math.random() * n);
const randomText = () =>
  Array.from({ length: rand(12) }, () => 'abc\n'[rand(4)]).join('');

// Makes a random single splice edit of `doc`
function randomEdit(doc) {
  const start = rand(doc.length + 1);
  const end = Math.min(doc.length, start + rand(5));
  return doc.slice(0, start) + ['x', 'yy', ''][rand(3)] + doc.slice(end);
}

test('diffToOp produces an operation that yields the new text', () => {
  for (let i = 0; i < 500; i += 1) {
    const prev = randomText();
    const next = randomText();
    assert.equal(applyOp(prev, diffToOp(prev, next)), next);
  }
});

test('concurrent edits converge regardless of the order applied', () => {
  for (let i = 0; i < 5000; i += 1) {
    const doc = randomText();
    const a = diffToOp(doc, randomEdit(doc));
    const b = diffToOp(doc, randomEdit(doc));
    const [aPrime, bPrime] = transform(a, b);
    assert.equal(
      applyOp(applyOp(doc, a), bPrime),
      applyOp(applyOp(doc, b), aPrime)
    );
  }
});

test('simultaneous insertions at the same spot are both kept', () => {
  const [a2, b2] = transform(['A', 3], ['B', 3]);
  assert.equal(applyOp(applyOp('abc', ['A', 3]), b2), 'ABabc');
  assert.equal(applyOp(applyOp('abc', ['B', 3]), a2), 'ABabc');
});

test('transformIndex keeps a caret on the same character', () => {
  const op = ['xx', 5]; // insert at start of "hello"
  assert.equal(transformIndex(op, 3), 5);
  assert.equal(transformIndex([2, -2, 1], 4), 2); // caret inside deletion
});

// Builds a random operation made of several separate edits
function randomMultiEdit(doc) {
  let text = doc;
  let op = text.length ? [text.length] : [];
  for (let i = rand(4); i >= 0; i -= 1) {
    const next = randomEdit(text);
    op = compose(op, diffToOp(text, next));
    text = next;
  }
  return { op, text };
}

test('compose is equivalent to applying operations one after another', () => {
  for (let i = 0; i < 5000; i += 1) {
    const doc = randomText();
    const first = randomMultiEdit(doc);
    const second = randomMultiEdit(first.text);
    assert.equal(applyOp(doc, first.op), first.text);
    assert.equal(
      applyOp(doc, compose(first.op, diffToOp(first.text, second.text))),
      second.text
    );
  }
});

test('multi-part concurrent operations converge', () => {
  for (let i = 0; i < 5000; i += 1) {
    const doc = randomText();
    const a = randomMultiEdit(doc);
    const b = randomMultiEdit(doc);
    const [aPrime, bPrime] = transform(a.op, b.op);
    assert.equal(applyOp(b.text, aPrime), applyOp(a.text, bPrime));
  }
});
