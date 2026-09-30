import { useState } from 'react';

function FileTreeNode({ node, onCreateFile, onCreateDirectory, onRename }) {
  const [isOpen, setIsOpen] = useState(true);

  const isDirectory = node.type === 'directory';

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
        <span>{node.name}</span>

        <button type="button" onClick={() => onRename(node.id, node.name)}>
          Rename
        </button>

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
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default FileTreeNode;
