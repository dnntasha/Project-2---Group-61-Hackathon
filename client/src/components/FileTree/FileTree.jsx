import { memo, useState } from 'react';
import FileTreeNode from './FileTreeNode.jsx';
import {
  applyTreeOperation,
  createFileNode,
  getDirectories,
  isDescendant,
  findNode,
  hasDuplicateName,
  isValidNodeName,
  findParentNode,
} from './fileTreeUtils.js';
import './FileTree.css';

/**
 * FileTree renders the project's file system and lets the user create, rename,
 * delete and move files/directories.
 *
 * Shared mode (`tree` and `onOperation` props): the tree belongs to the server
 * so every member of a room sees the same structure. User actions are
 * validated here for quick feedback, then sent as operations through
 * `onOperation`; the tree only changes when the server sends the result back.
 *
 * `readOnly` hides the buttons that change the tree, so it can still be browsed
 * (and files opened) while the room is locked.
 *
 * Local mode (no props): the tree lives in this component's state and
 * operations are applied immediately with the same rules the server uses.
 *
 * Node format:
 * File:      { id, name, type: 'file', content }
 * Directory: { id, name, type: 'directory', children }
 */
function FileTree({
  tree: sharedTree,
  onOperation,
  onSelectFile,
  selectedPath,
  readOnly = false,
}) {
  const isShared = Boolean(onOperation);
  const [localTree, setLocalTree] = useState(() => ({
    id: 'root',
    name: 'Code',
    type: 'directory',
    children: [createFileNode('main.py')],
  }));
  const tree = isShared ? sharedTree : localTree;

  // Sends the operation to the server, or applies it locally
  function dispatch(operation) {
    if (isShared) {
      onOperation(operation);
      return;
    }

    const result = applyTreeOperation(localTree, operation);

    if (result.error) {
      window.alert(result.error);
      return;
    }

    setLocalTree(result.tree);
  }

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

    dispatch({
      type: 'create',
      parentId,
      nodeType: 'file',
      name: trimmedName,
    });
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

    dispatch({
      type: 'create',
      parentId,
      nodeType: 'directory',
      name: trimmedName,
    });
  }

  // Renames a node while excluding that node itself from duplicate-name checks.
  // The new name comes from the inline editor in FileTreeNode.
  function handleRename(nodeId, currentName, newName) {
    const trimmedName = newName.trim();

    if (trimmedName === currentName) {
      return;
    }

    if (!isValidNodeName(trimmedName)) {
      window.alert('Please enter a valid name.');
      return;
    }

    const parent = findParentNode(tree, nodeId);

    if (parent && hasDuplicateName(tree, parent.id, trimmedName, nodeId)) {
      window.alert('A file or folder with that name already exists.');
      return;
    }

    dispatch({ type: 'rename', nodeId, name: trimmedName });
  }
  // Removes a node and, for directories, its complete subtree after confirmation.
  function handleDelete(nodeId, nodeName) {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${nodeName}"?`
    );

    if (!confirmed) {
      return;
    }

    dispatch({ type: 'delete', nodeId });
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

    dispatch({
      type: 'move',
      nodeId,
      destinationId: destinations[destinationIndex].id,
    });
  }

  return (
    <aside className="file-tree">
      <h2>Files</h2>

      {!tree ? (
        <p>Loading files...</p>
      ) : (
        <FileTreeNode
          node={tree}
          onCreateFile={handleCreateFile}
          onCreateDirectory={handleCreateDirectory}
          onRename={handleRename}
          onDelete={handleDelete}
          onMove={handleMove}
          onSelectFile={onSelectFile} //adds functionality of selecting files
          selectedPath={selectedPath} // highlights the open file
          readOnly={readOnly}
          path=""
        />
      )}
    </aside>
  );
}

// Memoised so typing in the editor doesn't re-render the whole tree
export default memo(FileTree);
