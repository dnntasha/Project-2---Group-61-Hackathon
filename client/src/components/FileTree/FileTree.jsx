import { useState } from 'react';
import FileTreeNode from './FileTreeNode.jsx';
import {
  addNode,
  createDirectoryNode,
  createFileNode,
  renameNode,
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

  return (
    <aside className="file-tree">
      <h2>Files</h2>

      <FileTreeNode
        node={tree}
        onCreateFile={handleCreateFile}
        onCreateDirectory={handleCreateDirectory}
        onRename={handleRename}
      />
    </aside>
  );
}

export default FileTree;
