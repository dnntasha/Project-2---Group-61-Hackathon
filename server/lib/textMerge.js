// Merge changes made against a common base.
// Non-overlapping edits are preserved; conflicting edits favour incoming.
function changes(base, updated) {
  const a = base.split('\n');
  const b = updated.split('\n');
  const n = a.length;
  const m = b.length;

  // Bound the quadratic diff work for unusually large files.
  if (n * m > 250000) return null;

  const dp = Array.from({ length: n + 1 }, () =>
    new Uint32Array(m + 1)
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? 1 + dp[i + 1][j + 1]
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const edits = [];
  let i = 0;
  let j = 0;
  let start = null;
  let replacement = [];

  function flush() {
    if (start !== null) {
      edits.push({ start, end: i, replacement });
      start = null;
      replacement = [];
    }
  }

  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else {
      if (start === null) start = i;

      if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
        replacement.push(b[j++]);
      } else {
        i++;
      }
    }
  }
  flush();
  return edits;
}

export function mergeText(base, current, incoming) {
  if (current === base) return incoming;
  if (incoming === base) return current;
  if (current === incoming) return current;

  const ours = changes(base, current);
  const theirs = changes(base, incoming);

  // Never silently overwrite another teammate's changes when a
  // three-way merge exceeds the diff complexity limit.
  if (!ours || !theirs) {
    throw new RangeError('Text merge exceeds complexity limit.');
  }

  const baseLines = base.split('\n');
  const result = [];
  let position = 0;
  let oi = 0;
  let ti = 0;

  while (position < baseLines.length || oi < ours.length || ti < theirs.length) {
    const o = ours[oi];
    const t = theirs[ti];

    const next = Math.min(
      o?.start ?? Infinity,
      t?.start ?? Infinity,
      baseLines.length
    );

    if (position < next) {
      result.push(...baseLines.slice(position, next));
      position = next;
      continue;
    }

    if (!o && !t) break;

    // Insertions consume no base lines. Preserve them before a replacement
    // beginning at the same position instead of treating them as conflicts.
    if (o && o.start === o.end &&
        (!t || o.start <= t.start) &&
        o.start === position) {
      result.push(...o.replacement);
      oi++;
      continue;
    }

    if (t && t.start === t.end &&
        (!o || t.start < o.start) &&
        t.start === position) {
      result.push(...t.replacement);
      ti++;
      continue;
    }

    if (o && (!t || o.end <= t.start && o.start < t.start)) {
      result.push(...o.replacement);
      position = o.end;
      oi++;
      continue;
    }

    if (t && (!o || t.end <= o.start && t.start < o.start)) {
      result.push(...t.replacement);
      position = t.end;
      ti++;
      continue;
    }

    // Overlapping edits: incoming wins for the affected region.
    const end = Math.max(o?.end ?? position, t?.end ?? position);
    result.push(...(t?.replacement ?? []));
    position = end;
    if (o) oi++;
    if (t) ti++;
  }

  return result.join('\n');
}
