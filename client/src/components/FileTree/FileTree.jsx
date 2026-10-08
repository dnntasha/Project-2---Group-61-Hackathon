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
  hasDuplicateName,
  isValidNodeName,
  findParentNode,
} from './fileTreeUtils.js';
import './FileTree.css';

/**
 * FileTree owns the local representation of the project's file system.
 *
 * P4 responsibility:
 * - Render the recursive file/directory structure.
 * - Create, rename, delete and move files/directories locally.
 *
 * P3 integration:
 * - The tree currently lives in local React state.
 * - P3's WebSocket layer should synchronise these file operations between
 *   team members using the stable node IDs.
 * - Once shared state is connected, remote operations can update this tree
 *   through the same tree utility functions used by the local handlers.
 *
 * Node format:
 * File:      { id, name, type: 'file', content }
 * Directory: { id, name, type: 'directory', children }
 */
function FileTree({ onSelectFile, selectedPath }) {
  //allows us to select files
  const [tree, setTree] = useState(() => ({
    id: 'root',
    name: 'Code',
    type: 'directory',
    children: [createFileNode('main.py')],
  }));

  function handleCreateFile(parentId) {
    const name = window.prompt('Enter file name:');

    if (name === null) {
      return;
    }

    const trimmedName = name.trim();

    if (!isValidNodeName(trimmedName)) {
      window.alert('Please enter a valid file name.');
      return;
    }

    if (hasDuplicateName(tree, parentId, trimmedName)) {
      window.alert('A file or folder with that name already exists.');
      return;
    }

    const newFile = createFileNode(trimmedName);

    setTree((currentTree) => addNode(currentTree, parentId, newFile));
  }

  // Creates a file inside the selected directory after validating its name
  //and checking for a sibling name collision.
  function handleCreateDirectory(parentId) {
    const name = window.prompt('Enter folder name:');

    if (name === null) {
      return;
    }

    const trimmedName = name.trim();

    if (!isValidNodeName(trimmedName)) {
      window.alert('Please enter a valid folder name.');
      return;
    }

    if (hasDuplicateName(tree, parentId, trimmedName)) {
      window.alert('A file or folder with that name already exists.');
      return;
    }

    const newDirectory = createDirectoryNode(trimmedName);

    setTree((currentTree) => addNode(currentTree, parentId, newDirectory));
  }

  // Renames a node while excluding that node itself from duplicate-name checks.
  function handleRename(nodeId, currentName) {
    const newName = window.prompt('Enter new name:', currentName);

    if (newName === null) {
      return;
    }

    const trimmedName = newName.trim();

    if (!isValidNodeName(trimmedName)) {
      window.alert('Please enter a valid name.');
      return;
    }

    const parent = findParentNode(tree, nodeId);

    if (parent && hasDuplicateName(tree, parent.id, trimmedName, nodeId)) {
      window.alert('A file or folder with that name already exists.');
      return;
    }

    setTree((currentTree) => renameNode(currentTree, nodeId, trimmedName));
  }
  // Removes a node and, for directories, its complete subtree after confirmation.
  function handleDelete(nodeId, nodeName) {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${nodeName}"?`
    );

    if (!confirmed) {
      return;
    }

    setTree((currentTree) => deleteNode(currentTree, nodeId));
  }
  // Moves a node to another directory.
  // Valid destinations exclude the node itself, its descendants and destinations
  // that would create a sibling name collision.
  function handleMove(nodeId) {
    const nodeToMove = findNode(tree, nodeId);

    if (!nodeToMove) {
      return;
    }

    const destinations = getDirectories(tree).filter(
      (directory) =>
        directory.id !== nodeId &&
        !isDescendant(nodeToMove, directory.id) &&
        !hasDuplicateName(tree, directory.id, nodeToMove.name, nodeId)
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
        onSelectFile={onSelectFile} //adds functionality of selecting files
        selectedPath={selectedPath} // highlights the open file
        path=""
      />
    </aside>
  );
}

export default FileTree;
