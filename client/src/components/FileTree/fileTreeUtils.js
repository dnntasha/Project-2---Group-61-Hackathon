export function createFileNode(name = 'untitled.py') {
  return {
    id: globalThis.crypto.randomUUID(),
    name,
    type: 'file',
    content: '',
  };
}

export function createDirectoryNode(name = 'new-folder') {
  return {
    id: globalThis.crypto.randomUUID(),
    name,
    type: 'directory',
    children: [],
  };
}

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

export function getDirectories(tree) {
  if (tree.type !== 'directory') {
    return [];
  }

  return [tree, ...tree.children.flatMap((child) => getDirectories(child))];
}
