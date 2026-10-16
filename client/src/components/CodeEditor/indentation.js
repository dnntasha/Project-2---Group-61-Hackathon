// Pure helpers for the editor's Python-friendly indentation behaviour. They
// work on plain strings and character offsets, so they can be tested without a
// browser; CodeEditor.jsx applies the results to the textarea.

export const INDENT = '    ';

// Keywords that end a block's body: the line after one is one level shallower
const BLOCK_ENDING = /^(?:return|pass|break|continue|raise)\b/;
// A line that opens a block: ends with ':' (optionally followed by a comment)
const OPENS_BLOCK = /:\s*(?:#.*)?$/;

// Removes one indent level (four spaces, or a tab) from an indentation string
function removeIndentLevel(indentation) {
  if (indentation.endsWith('\t')) return indentation.slice(0, -1);
  return indentation.slice(0, Math.max(0, indentation.length - INDENT.length));
}

/**
 * The indentation the line after `lineBeforeCursor` should start with, where
 * `lineBeforeCursor` is the current line up to the caret.
 *  - after a line ending in ':' the next line is one level deeper
 *    (this includes else:, elif ...:, except ...: and finally:, whose bodies
 *    are indented relative to the keyword itself)
 *  - after return/pass/break/continue/raise it is one level shallower
 *  - otherwise it keeps the current line's indentation
 */
export function nextLineIndentation(lineBeforeCursor) {
  const indentation = lineBeforeCursor.match(/^[\t ]*/)[0];
  const text = lineBeforeCursor.slice(indentation.length);

  if (OPENS_BLOCK.test(lineBeforeCursor)) return indentation + INDENT;
  if (BLOCK_ENDING.test(text)) return removeIndentLevel(indentation);
  return indentation;
}

/**
 * Indents (or, with `dedent`, outdents) every line touched by the selection
 * `start..end` and returns the new text with the selection moved to match.
 * A selection that ends right after a newline doesn't include the next line.
 * Blank lines are left alone when indenting.
 */
export function shiftLines(value, start, end, dedent) {
  const blockStart = value.lastIndexOf('\n', start - 1) + 1;
  const lastIncluded = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const newlineAfter = value.indexOf('\n', lastIncluded);
  const blockEnd = newlineAfter === -1 ? value.length : newlineAfter;

  const lines = value.slice(blockStart, blockEnd).split('\n');
  // Each line's original offset, length and how much it grew or shrank
  const info = [];
  let position = blockStart;

  const shifted = lines.map((line) => {
    let result = line;
    let delta = 0;

    if (dedent) {
      const match = /^(?: {1,4}|\t)/.exec(line);
      const removed = match ? match[0].length : 0;
      result = line.slice(removed);
      delta = -removed;
    } else if (line) {
      result = INDENT + line;
      delta = INDENT.length;
    }

    info.push({ position, length: line.length, delta });
    position += line.length + 1;
    return result;
  });

  const totalDelta = info.reduce((sum, line) => sum + line.delta, 0);

  // Where an original offset ends up after the lines have been shifted
  const mapIndex = (index) => {
    if (index > blockEnd) return index + totalDelta;

    let before = 0; // total change on the lines above this one
    for (const line of info) {
      if (index <= line.position + line.length) {
        // A caret at the very start of a line stays put, and one inside a
        // removed indent can't move above the start of its line
        const moved =
          index > line.position
            ? Math.max(line.position + before, index + before + line.delta)
            : line.position + before;
        return moved;
      }
      before += line.delta;
    }
    return index + totalDelta;
  };

  return {
    value:
      value.slice(0, blockStart) + shifted.join('\n') + value.slice(blockEnd),
    selectionStart: mapIndex(start),
    selectionEnd: mapIndex(end),
  };
}
