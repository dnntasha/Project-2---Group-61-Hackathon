/**
 * Converts an editor room's state into the codebase tree the grader expects.
 *
 * A room holds `tree` (folders and files, see client fileTreeUtils.js) and
 * `files`, a Map or plain object from each file's path ("lib/util.py") to its
 * text. The evaluator wants `{ type: 'directory', children: [...] }` whose
 * file nodes carry their own `content`. Building it on the server means a
 * submission always grades what the team actually has saved, never text the
 * client sends along with the request.
 */
export function roomToCodebase(tree, files) {
  const lookup = files instanceof Map ? files : new Map(Object.entries(files));

  function convert(node, parentPath) {
    const nodePath = parentPath ? `${parentPath}/${node.name}` : node.name;

    if (node.type === 'directory') {
      return {
        type: 'directory',
        name: node.name,
        children: (node.children ?? []).map((child) =>
          convert(child, nodePath)
        ),
      };
    }

    const stored = lookup.get(nodePath);
    // Rooms keep a Map of { code } records; saved rooms use plain strings
    const content = typeof stored === 'string' ? stored : (stored?.code ?? '');
    return { type: 'file', name: node.name, content };
  }

  // The root folder is not part of file paths, so its children start at ''
  return {
    type: 'directory',
    children: (tree?.children ?? []).map((child) => convert(child, '')),
  };
}
