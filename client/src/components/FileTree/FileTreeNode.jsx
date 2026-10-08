import { useState } from 'react';

/**
 * Recursively renders one node in the file tree.
 *
 * Directories can be expanded/collapsed and recursively render their children.
 * File operations are passed down from FileTree so that all modifications are
 * applied to the single tree state owned by the parent component.
 *
 * The root node cannot be moved or deleted.
 */
function FileTreeNode({
  node,
  onCreateFile,
  onCreateDirectory,
  onRename,
  onDelete,
  onMove,
  onSelectFile,
  path,
}) {
  const [isOpen, setIsOpen] = useState(true);

  const isDirectory = node.type === 'directory';
  const nodePath =
    node.id === 'root' ? '' : path ? `${path}/${node.name}` : node.name;

  return (
    <div className="file-tree-node">
      <div className="file-tree-row">
        {isDirectory ? (
          <button
            type="button"
            className="file-tree-toggle"
            onClick={() => setIsOpen((current) => !current)}
          >
            {isOpen ? '▼' : '▶'}
          </button>
        ) : (
          <span className="file-tree-toggle-placeholder" />
        )}

        <span>{isDirectory ? '📁' : '📄'}</span>

        {isDirectory /*This block of code allows us to be able to select different files to edit*/ ? (
          <span>{node.name}</span>
        ) : (
          <button
            type="button"
            className="file-tree-file"
            onClick={() => onSelectFile?.(nodePath)}
          >
            {node.name}
          </button>
        )}

        <button type="button" onClick={() => onRename(node.id, node.name)}>
          Rename
        </button>

        {node.id !== 'root' && (
          <button type="button" onClick={() => onMove(node.id)}>
            Move
          </button>
        )}

        {node.id !== 'root' && (
          <button type="button" onClick={() => onDelete(node.id, node.name)}>
            Delete
          </button>
        )}

        {isDirectory && (
          <>
            <button type="button" onClick={() => onCreateFile(node.id)}>
              + File
            </button>

            <button type="button" onClick={() => onCreateDirectory(node.id)}>
              + Folder
            </button>
          </>
        )}
      </div>

      {isDirectory && isOpen && (
        <div className="file-tree-children">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.id}
              node={child}
              onCreateFile={onCreateFile}
              onCreateDirectory={onCreateDirectory}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              onSelectFile={onSelectFile}
              path={nodePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default FileTreeNode;
