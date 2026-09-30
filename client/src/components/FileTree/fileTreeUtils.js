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
