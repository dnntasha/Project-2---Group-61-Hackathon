/**
 * Creates a file node with a stable unique ID.
 * The ID allows operations to target the same file even after rename/move
 * and can also be used by the WebSocket synchronisation layer.
 */
export function createFileNode(name = 'untitled.py') {
  return {
    id: globalThis.crypto.randomUUID(),
    name,
    type: 'file',
    content: '',
  };
}

/**
 * Creates an empty directory node with a stable unique ID.
 */
export function createDirectoryNode(name = 'new-folder') {
  return {
    id: globalThis.crypto.randomUUID(),
    name,
    type: 'directory',
    children: [],
  };
}

/**
 * Immutably adds newNode to the directory identified by parentId.
 * Recursion allows the parent directory to exist at any depth in the tree.
 */
export function addNode(tree, parentId, newNode) {
  if (tree.id === parentId && tree.type === 'directory') {
    return {
      ...tree,
      children: [...tree.children, newNode],
    };
  }

  if (tree.type === 'directory') {
    return {
      ...tree,
      children: tree.children.map((child) => addNode(child, parentId, newNode)),
    };
  }

  return tree;
}

/**
 * Immutably renames the node identified by nodeId.
 * The node ID remains unchanged so references survive a rename.
 */
export function renameNode(tree, nodeId, newName) {
  if (tree.id === nodeId) {
    return {
      ...tree,
      name: newName,
    };
  }

  if (tree.type === 'directory') {
    return {
      ...tree,
      children: tree.children.map((child) =>
        renameNode(child, nodeId, newName)
      ),
    };
  }

  return tree;
}

/**
 * Immutably removes the node identified by nodeId.
 * Deleting a directory also removes its complete subtree.
 */
export function deleteNode(tree, nodeId) {
  if (tree.type !== 'directory') {
    return tree;
  }

  return {
    ...tree,
    children: tree.children
      .filter((child) => child.id !== nodeId)
      .map((child) => deleteNode(child, nodeId)),
  };
}

/**
 * Recursively finds a node by its stable ID.
 * Returns null when the node does not exist.
 */
export function findNode(tree, nodeId) {
  if (tree.id === nodeId) {
    return tree;
  }

  if (tree.type === 'directory') {
    for (const child of tree.children) {
      const foundNode = findNode(child, nodeId);

      if (foundNode) {
        return foundNode;
      }
    }
  }

  return null;
}

/**
 * Returns true when possibleDescendantId occurs anywhere below node.
 * Used to prevent moving a directory into one of its own descendants.
 */
export function isDescendant(node, possibleDescendantId) {
  if (node.type !== 'directory') {
    return false;
  }

  for (const child of node.children) {
    if (child.id === possibleDescendantId) {
      return true;
    }

    if (isDescendant(child, possibleDescendantId)) {
      return true;
    }
  }

  return false;
}

/**
 * Moves a node by removing it from its current location and adding the same
 * node object to the destination directory.
 *
 * The operation preserves the node ID and prevents invalid moves involving
 * the root, the node itself, non-directory destinations or descendants.
 */
export function moveNode(tree, nodeId, destinationId) {
  if (nodeId === 'root' || nodeId === destinationId) {
    return tree;
  }

  const nodeToMove = findNode(tree, nodeId);
  const destination = findNode(tree, destinationId);

  if (!nodeToMove || !destination || destination.type !== 'directory') {
    return tree;
  }

  if (
    nodeToMove.type === 'directory' &&
    isDescendant(nodeToMove, destinationId)
  ) {
    return tree;
  }

  const treeWithoutNode = deleteNode(tree, nodeId);

  return addNode(treeWithoutNode, destinationId, nodeToMove);
}

/**
 * Returns every directory in the tree.
 * FileTree uses this list when presenting valid move destinations.
 */
export function getDirectories(tree) {
  if (tree.type !== 'directory') {
    return [];
  }

  return [tree, ...tree.children.flatMap((child) => getDirectories(child))];
}

/**
 * Checks whether a sibling with the requested name already exists.
 *
 * Current behaviour is case-insensitive and treats file/directory names as
 * sharing the same namespace. These semantics are not defined by the project
 * specification and should be agreed by the team before being changed.
 *
 * excludeNodeId allows a node to retain its current name during rename checks.
 */
export function hasDuplicateName(tree, parentId, name, excludeNodeId = null) {
  const parent = findNode(tree, parentId);

  if (!parent || parent.type !== 'directory') {
    return false;
  }

  return parent.children.some(
    (child) =>
      child.id !== excludeNodeId &&
      child.name.toLowerCase() === name.toLowerCase()
  );
}

/**
 * Performs the current client-side filename validation.
 * Empty names and names containing path separators are rejected so a node
 * name cannot create an unintended nested path.
 */
export function isValidNodeName(name) {
  if (!name || !name.trim()) {
    return false;
  }

  return !name.includes('/') && !name.includes('\\');
}

/**
 * Recursively finds the directory directly containing nodeId.
 * Used primarily when validating rename operations.
 */
export function findParentNode(tree, nodeId) {
  if (tree.type !== 'directory') {
    return null;
  }

  for (const child of tree.children) {
    if (child.id === nodeId) {
      return tree;
    }

    const parent = findParentNode(child, nodeId);

    if (parent) {
      return parent;
    }
  }

  return null;
}
