import { useEffect, useRef, useState } from 'react';

/**
 * Recursively renders one node in the file tree.
 *
 * Directories can be expanded/collapsed and recursively render their children.
 * File operations are passed down from FileTree so that all modifications are
 * applied to the single tree state owned by the parent component.
 *
 * Clicking an entry opens a file / toggles a folder; double-clicking its name
 * (or pressing F2) turns the name into an input for renaming.
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
  selectedPath,
  readOnly,
  path,
}) {
  const [isOpen, setIsOpen] = useState(true);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const inputRef = useRef(null);
  // Enter/Escape unmount the input, which fires blur; this stops a second commit
  const finishedRef = useRef(false);

  const isDirectory = node.type === 'directory';
  const nodePath =
    node.id === 'root' ? '' : path ? `${path}/${node.name}` : node.name;
  const isSelected = !isDirectory && nodePath === selectedPath;

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  function startRenaming() {
    if (readOnly) {
      return;
    }

    finishedRef.current = false;
    setDraftName(node.name);
    setIsRenaming(true);
  }

  function finishRenaming(commit) {
    if (finishedRef.current) {
      return;
    }

    finishedRef.current = true;
    setIsRenaming(false);

    if (commit) {
      onRename(node.id, node.name, draftName);
    }
  }

  function handleClick() {
    if (isRenaming) {
      return;
    }

    if (isDirectory) {
      setIsOpen((current) => !current);
    } else {
      onSelectFile?.(nodePath);
    }
  }

  function handleKeyDown(event) {
    if (isRenaming || event.target !== event.currentTarget) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    } else if (event.key === 'F2') {
      event.preventDefault();
      startRenaming();
    }
  }

  return (
    <div className="file-tree-node">
      <div className={`file-tree-entry${isSelected ? ' selected' : ''}`}>
        <div
          className="file-tree-main"
          role="button"
          tabIndex={0}
          aria-current={isSelected ? 'true' : undefined}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
        >
          <span className="file-tree-toggle" aria-hidden="true">
            {isDirectory ? (isOpen ? '▼' : '▶') : ''}
          </span>

          <span aria-hidden="true">{isDirectory ? '📁' : '📄'}</span>

          {isRenaming ? (
            <input
              ref={inputRef}
              className="file-tree-rename-input"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();

                if (event.key === 'Enter') {
                  finishRenaming(true);
                } else if (event.key === 'Escape') {
                  finishRenaming(false);
                }
              }}
              onBlur={() => finishRenaming(true)}
            />
          ) : (
            <span
              className="file-tree-name"
              title={readOnly ? undefined : 'Double-click to rename'}
              onDoubleClick={startRenaming}
            >
              {node.name}
            </span>
          )}
        </div>

        {!readOnly && (
          <div className="file-tree-actions">
            {node.id !== 'root' && (
              <button type="button" onClick={() => onMove(node.id)}>
                Move
              </button>
            )}

            {node.id !== 'root' && (
              <button
                type="button"
                onClick={() => onDelete(node.id, node.name)}
              >
                Delete
              </button>
            )}

            {isDirectory && (
              <>
                <button type="button" onClick={() => onCreateFile(node.id)}>
                  + File
                </button>

                <button
                  type="button"
                  onClick={() => onCreateDirectory(node.id)}
                >
                  + Folder
                </button>
              </>
            )}
          </div>
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
              selectedPath={selectedPath}
              readOnly={readOnly}
              path={nodePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default FileTreeNode;
