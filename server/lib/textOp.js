/**
 * Text operations for concurrent editing (operational transformation).
 *
 * An operation describes how to turn one version of a document into the next
 * as an array of components, walked from the start of the document:
 *   - a positive number n  -> keep (retain) the next n characters
 *   - a negative number -n -> delete the next n characters
 *   - a string             -> insert that text at the current position
 * e.g. turning "hello world" into "hello there" is [6, 'there', -5].
 * An operation must cover the whole document, so its "base length" (retained +
 * deleted characters) has to equal the length of the text it is applied to.
 *
 * The key function is `transform`: given two operations made concurrently
 * against the same document, it returns versions of each that can be applied
 * after the other and still give the same result, so every user converges on
 * identical text even when edits cross in flight.
 *
 * This file is shared: the client imports it directly from here.
 */

// Builders that merge neighbouring components and keep inserts before deletes,
// so equivalent operations always have the same canonical shape.
function pushRetain(ops, n) {
  if (n <= 0) return;
  const last = ops[ops.length - 1];
  if (typeof last === 'number' && last > 0) ops[ops.length - 1] = last + n;
  else ops.push(n);
}

function pushInsert(ops, text) {
  if (!text) return;
  const last = ops[ops.length - 1];
  if (typeof last === 'string') {
    ops[ops.length - 1] = last + text;
  } else if (typeof last === 'number' && last < 0) {
    const beforeDelete = ops[ops.length - 2];
    if (typeof beforeDelete === 'string') {
      ops[ops.length - 2] = beforeDelete + text;
    } else {
      ops.splice(ops.length - 1, 0, text);
    }
  } else {
    ops.push(text);
  }
}

function pushDelete(ops, n) {
  if (n <= 0) return;
  const last = ops[ops.length - 1];
  if (typeof last === 'number' && last < 0) ops[ops.length - 1] = last - n;
  else ops.push(-n);
}

// Checks that untrusted input is a well-formed operation (shape only).
export function isValidOp(op) {
  return (
    Array.isArray(op) &&
    op.length <= 1000 &&
    op.every(
      (c) =>
        typeof c === 'string' ||
        (typeof c === 'number' && Number.isInteger(c) && c !== 0)
    )
  );
}

// Applies an operation to a string. Throws if it doesn't fit the text.
export function applyOp(text, op) {
  let pos = 0;
  let out = '';
  for (const c of op) {
    if (typeof c === 'string') {
      out += c;
    } else if (c > 0) {
      if (pos + c > text.length) throw new Error('Operation is too long');
      out += text.slice(pos, pos + c);
      pos += c;
    } else {
      pos += -c;
    }
  }
  if (pos !== text.length) throw new Error('Operation length mismatch');
  return out;
}

/**
 * Transforms two concurrent operations `a` and `b` (both made against the
 * same document). Returns [a', b'] where applying a then b' equals applying
 * b then a'. When both insert at the same position, `a`'s text goes first.
 */
export function transform(a, b) {
  const aPrime = [];
  const bPrime = [];
  let i = 0;
  let j = 0;
  let ca = a[i++];
  let cb = b[j++];

  while (ca !== undefined || cb !== undefined) {
    if (typeof ca === 'string') {
      pushInsert(aPrime, ca);
      pushRetain(bPrime, ca.length);
      ca = a[i++];
      continue;
    }
    if (typeof cb === 'string') {
      pushRetain(aPrime, cb.length);
      pushInsert(bPrime, cb);
      cb = b[j++];
      continue;
    }
    if (ca === undefined || cb === undefined) {
      throw new Error('Operations apply to different document lengths');
    }

    const len = Math.min(Math.abs(ca), Math.abs(cb));
    if (ca > 0 && cb > 0) {
      pushRetain(aPrime, len);
      pushRetain(bPrime, len);
    } else if (ca < 0 && cb > 0) {
      pushDelete(aPrime, len);
    } else if (ca > 0 && cb < 0) {
      pushDelete(bPrime, len);
    } // both delete the same text: nothing left to do for either

    ca = Math.abs(ca) === len ? a[i++] : ca > 0 ? ca - len : ca + len;
    cb = Math.abs(cb) === len ? b[j++] : cb > 0 ? cb - len : cb + len;
  }
  return [aPrime, bPrime];
}

/**
 * Combines two operations made one after the other (`a` on the original text,
 * then `b` on the result) into a single operation with the same effect.
 */
export function compose(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  let ca = a[i++];
  let cb = b[j++];

  while (ca !== undefined || cb !== undefined) {
    // Deletions in `a` remove original text, which `b` never saw
    if (typeof ca === 'number' && ca < 0) {
      pushDelete(out, -ca);
      ca = a[i++];
      continue;
    }
    // Insertions in `b` add text that `a` never saw
    if (typeof cb === 'string') {
      pushInsert(out, cb);
      cb = b[j++];
      continue;
    }
    if (ca === undefined || cb === undefined) {
      throw new Error('Operations cannot be composed: length mismatch');
    }

    // Otherwise `a` produces some text (retained or inserted) that `b`
    // retains or deletes; walk through the overlap
    const lenA = typeof ca === 'string' ? ca.length : ca;
    const lenB = Math.abs(cb);
    const len = Math.min(lenA, lenB);
    if (typeof ca === 'string') {
      if (cb > 0) pushInsert(out, ca.slice(0, len));
      // else: `b` deletes text `a` inserted, so neither shows up
      ca = len < lenA ? ca.slice(len) : a[i++];
    } else {
      if (cb > 0) pushRetain(out, len);
      else pushDelete(out, len);
      ca = len < lenA ? ca - len : a[i++];
    }
    cb = len < lenB ? (cb > 0 ? cb - len : cb + len) : b[j++];
  }
  return out;
}

// Builds the smallest single-splice operation turning `prev` into `next`
// by trimming their common prefix and suffix.
export function diffToOp(prev, next) {
  let start = 0;
  while (
    start < prev.length &&
    start < next.length &&
    prev[start] === next[start]
  ) {
    start += 1;
  }
  let suffix = 0;
  while (
    suffix < prev.length - start &&
    suffix < next.length - start &&
    prev[prev.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const op = [];
  pushRetain(op, start);
  pushInsert(op, next.slice(start, next.length - suffix));
  pushDelete(op, prev.length - start - suffix);
  pushRetain(op, suffix);
  return op;
}

// Maps a cursor position in the old text to the matching position in the new
// text after `op` is applied (used to keep carets stable on remote edits).
export function transformIndex(op, index) {
  let oldPos = 0;
  let newPos = 0;
  for (const c of op) {
    if (typeof c === 'string') {
      if (index <= oldPos) return newPos;
      newPos += c.length;
    } else if (c > 0) {
      if (index <= oldPos + c) return newPos + (index - oldPos);
      oldPos += c;
      newPos += c;
    } else {
      if (index <= oldPos - c) return newPos;
      oldPos += -c;
    }
  }
  return newPos + (index - oldPos);
}
