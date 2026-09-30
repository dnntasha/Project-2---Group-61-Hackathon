import { useState } from 'react';
import FileTreeNode from './FileTreeNode.jsx';
import {
  addNode,
  createDirectoryNode,
  createFileNode,
  deleteNode,
  renameNode,
  getDirectories,
  isDescendant,
  moveNode,
  findNode,
} from './fileTreeUtils.js';
import './FileTree.css';

function FileTree() {
  const [tree, setTree] = useState(() => ({
    id: 'root',
    name: 'Code',
    type: 'directory',
    children: [createFileNode('main.py')],
  }));

  function handleCreateFile(parentId) {
    const name = window.prompt('Enter file name:');

    if (!name || !name.trim()) {
      return;
    }

    const newFile = createFileNode(name.trim());

    setTree((currentTree) => addNode(currentTree, parentId, newFile));
  }

  function handleCreateDirectory(parentId) {
    const name = window.prompt('Enter folder name:');

    if (!name || !name.trim()) {
      return;
    }

    const newDirectory = createDirectoryNode(name.trim());

    setTree((currentTree) => addNode(currentTree, parentId, newDirectory));
  }

  function handleRename(nodeId, currentName) {
    const newName = window.prompt('Enter new name:', currentName);

    if (!newName || !newName.trim()) {
      return;
    }

    setTree((currentTree) => renameNode(currentTree, nodeId, newName.trim()));
  }

  function handleDelete(nodeId, nodeName) {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${nodeName}"?`
    );

    if (!confirmed) {
      return;
    }

    setTree((currentTree) => deleteNode(currentTree, nodeId));
  }

  function handleMove(nodeId) {
    const nodeToMove = findNode(tree, nodeId);

    if (!nodeToMove) {
      return;
    }

    const destinations = getDirectories(tree).filter(
      (directory) =>
        directory.id !== nodeId && !isDescendant(nodeToMove, directory.id)
    );

    if (destinations.length === 0) {
      window.alert('There are no valid destination folders.');
      return;
    }

    const destinationList = destinations
      .map((directory, index) => `${index + 1}. ${directory.name}`)
      .join('\n');

    const selection = window.prompt(
      `Move "${nodeToMove.name}" to:\n\n${destinationList}\n\nEnter destination number:`
    );

    if (selection === null) {
      return;
    }

    const destinationIndex = Number(selection) - 1;

    if (
      !Number.isInteger(destinationIndex) ||
      destinationIndex < 0 ||
      destinationIndex >= destinations.length
    ) {
      window.alert('Invalid destination.');
      return;
    }

    setTree((currentTree) =>
      moveNode(currentTree, nodeId, destinations[destinationIndex].id)
    );
  }

  return (
    <aside className="file-tree">
      <h2>Files</h2>

      <FileTreeNode
        node={tree}
        onCreateFile={handleCreateFile}
        onCreateDirectory={handleCreateDirectory}
        onRename={handleRename}
        onDelete={handleDelete}
        onMove={handleMove}
      />
    </aside>
  );
}

export default FileTree;
