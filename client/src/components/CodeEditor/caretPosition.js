/**
 * Map a cursor position from oldText into newText.
 *
 * Preserves the position relative to unchanged text when an edit
 * inserts or removes characters before the cursor.
 */
export function mapCaretPosition(oldText, newText, position) {
  const oldLength = oldText.length;
  const newLength = newText.length;
  const cursor = Math.max(0, Math.min(position, oldLength));

  if (oldText === newText) return cursor;

  let prefix = 0;
  while (
    prefix < oldLength &&
    prefix < newLength &&
    oldText[prefix] === newText[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLength - prefix &&
    suffix < newLength - prefix &&
    oldText[oldLength - 1 - suffix] === newText[newLength - 1 - suffix]
  ) {
    suffix++;
  }

  const oldChangeEnd = oldLength - suffix;
  const newChangeEnd = newLength - suffix;

  if (cursor <= prefix) return cursor;

  if (cursor >= oldChangeEnd) {
    return Math.max(0, Math.min(newLength, cursor + newLength - oldLength));
  }

  return newChangeEnd;
}

export function mapSelection(oldText, newText, selection) {
  return {
    start: mapCaretPosition(oldText, newText, selection.start),
    end: mapCaretPosition(oldText, newText, selection.end),
  };
}
