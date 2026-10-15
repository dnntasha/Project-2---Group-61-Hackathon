import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import FileTree from '../FileTree/FileTree.jsx';
import { api, getToken } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { getFilePathsById } from '../FileTree/fileTreeUtils.js';
import {
  applyOp,
  compose,
  diffToOp,
  transform,
  transformIndex,
} from '../../../../server/lib/textOp.js';
import './CodeEditor.css';

// The file that is open when the editor first loads
const DEFAULT_FILE = 'main.py';

// Builds the WebSocket URL, defaulting to ws(s)://<current host>/ws.
// The session token is passed as a query param because browsers can't set
// custom headers on WebSocket connections.
function getWebSocketUrl(wsUrl, roomId, problemId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(wsUrl || `${protocol}//${window.location.host}/ws`);
  const token = getToken();

  if (token) url.searchParams.set('token', token);
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('problemId', problemId);
  return url.toString();
}

// Formats a RUN_RESULTS message as the text shown in the terminal panel
function getRunOutput(message) {
  if (message.error) return `Run failed: ${message.error}`;

  const lines = [
    '--- RUN OUTPUT ---',
    `stdout:\n${message.stdout || '(no output)'}`,
  ];
  if (message.stderr) lines.push(`stderr:\n${message.stderr}`);
  if (message.timedOut)
    lines.push('Execution stopped after the 5-second limit.');
  if (message.outputLimitExceeded)
    lines.push('Output was truncated at the 64 KB limit.');
  lines.push(`Exit code: ${message.exitCode}`);
  return lines.join('\n\n');
}

/**
 * Collaborative Python editor.
 *
 * Connects to the server over a WebSocket and keeps every open file in sync
 * with the other users in the same room, so several people can type in the
 * same file at the same time and see each other's changes live.
 *
 * How syncing works (client side of operational transformation, see
 * lib/textOp.js):
 *  - For each file we track the last server `revision` we have seen, at most
 *    one `outstanding` operation that was sent but not yet acknowledged, a
 *    `buffer` operation holding everything typed since then, and `text` (what
 *    the user currently sees).
 *  - Typing updates `text` immediately and is added to the buffer. If nothing
 *    is outstanding, the buffer is sent; otherwise it waits for the ACK.
 *  - A remote operation is transformed against our outstanding and buffered
 *    changes before it is applied, so nobody's typing is overwritten, and the
 *    caret is shifted so it stays where the user was working.
 *
 * The file tree is shared the same way, but simpler: file/folder operations go
 * to the server, which applies them and sends the whole tree back to everyone.
 * When a tree update renames or moves a file, its sync state is carried over to
 * the new path; if the open file was deleted another file is shown.
 *
 * Props:
 *  - roomId:    room to join (falls back to ?roomId=, then the user's own room)
 *  - problemId: problem identifier sent to the server
 *  - wsUrl:     optional override of the WebSocket URL
 */
export default function CodeEditor({ roomId, problemId = 'prob-1', wsUrl }) {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [teams, setTeams] = useState([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [teamsError, setTeamsError] = useState('');

  const requestedRoomId = roomId || searchParams.get('roomId');

  const selectedTeam = teams.find((team) => String(team.id) === selectedTeamId);

  const activeRoomId = selectedTeam ? `team-${selectedTeam.id}` : null;

  useEffect(() => {
    let active = true;

    async function loadTeams() {
      setTeamsLoading(true);
      setTeamsError('');

      try {
        const response = await api('/my-teams');

        if (!active) return;

        const availableTeams = response.teams || [];
        setTeams(availableTeams);

        const requestedTeamId = /^team-([1-9]\d*)$/.exec(
          requestedRoomId || ''
        )?.[1];

        const matchingTeam = availableTeams.find(
          (team) => String(team.id) === requestedTeamId
        );

        setSelectedTeamId(
          matchingTeam
            ? String(matchingTeam.id)
            : availableTeams.length > 0
              ? String(availableTeams[0].id)
              : ''
        );
      } catch (error) {
        if (!active) return;

        setTeams([]);
        setSelectedTeamId('');
        setTeamsError(error.message || 'Could not load your teams.');
      } finally {
        if (active) setTeamsLoading(false);
      }
    }

    if (user?.id) {
      loadTeams();
    } else {
      setTeams([]);
      setSelectedTeamId('');
      setTeamsLoading(false);
    }

    return () => {
      active = false;
    };
  }, [user?.id, requestedRoomId]);

  // main.py is open as soon as the editor loads
  const [activeFilePath, setActiveFilePath] = useState(DEFAULT_FILE);
  const [code, setCode] = useState('');
  // The room's shared file tree (null until the server sends it)
  const [tree, setTree] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState(
    'Connecting to the shared Python workspace...'
  );

  // Refs hold values that message handlers need to read the *latest* value of
  // without being re-created (or triggering renders) on every change.
  const textareaRef = useRef(null);
  const socketRef = useRef(null);
  const activePathRef = useRef(activeFilePath);
  // filePath -> { revision, outstanding, buffer, text } (see above)
  const filesRef = useRef(new Map());
  // The latest tree received, readable from message handlers
  const treeRef = useRef(null);
  // Caret/selection to restore after a remote edit re-renders the textarea
  const pendingSelectionRef = useRef(null);
  const requestCounterRef = useRef(0);

  // Keep the ref in sync with state on every render
  activePathRef.current = activeFilePath;

  // Restore the caret after React has written a remote change to the textarea
  useLayoutEffect(() => {
    const selection = pendingSelectionRef.current;
    const textarea = textareaRef.current;
    if (selection && textarea) {
      pendingSelectionRef.current = null;
      if (document.activeElement === textarea) {
        textarea.setSelectionRange(selection.start, selection.end);
      }
    }
  }, [code]);

  // Sends a payload if the socket is open; returns whether it was sent
  const sendWsMessage = useCallback((payload) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
      return true;
    }
    setTerminalOutput(
      'Not connected. Reconnect before editing or running code.'
    );
    return false;
  }, []);

  // Sends the user's buffered changes to the server, but only when no earlier
  // operation is still awaiting its ACK (one in flight at a time keeps the
  // transform logic simple and the server's view unambiguous)
  const flushFile = useCallback(
    (filePath) => {
      const file = filesRef.current.get(filePath);
      if (!file || file.outstanding || !file.buffer) return;
      if (
        sendWsMessage({
          type: 'TEXT_EDIT',
          filePath,
          op: file.buffer,
          baseRevision: file.revision,
        })
      ) {
        file.outstanding = file.buffer;
        file.buffer = null;
      }
    },
    [sendWsMessage]
  );

  // Replaces our whole record of a file with the server's version, and shows
  // it if it is the active file
  const resetFile = useCallback((filePath, text, revision) => {
    filesRef.current.set(filePath, {
      revision,
      outstanding: null,
      buffer: null,
      text,
    });
    if (filePath === activePathRef.current) {
      pendingSelectionRef.current = null;
      setCode(text);
      setIsReady(true);
      setIsFileLoading(false);
    }
  }, []);

  // Applies an edit made by another user
  const applyRemoteEdit = useCallback(
    (message) => {
      const file = filesRef.current.get(message.filePath);
      // Unknown file, or we missed a revision: fetch a fresh copy instead
      if (!file || message.revision !== file.revision + 1) {
        sendWsMessage({ type: 'SELECT_FILE', filePath: message.filePath });
        return;
      }

      try {
        // Rebase the remote operation over our outstanding op and buffered
        // typing (and rebase those over it) so it fits what the user sees
        let remote = message.op;
        if (file.outstanding) {
          [file.outstanding, remote] = transform(file.outstanding, remote);
        }
        if (file.buffer) {
          [file.buffer, remote] = transform(file.buffer, remote);
        }

        const isActive = message.filePath === activePathRef.current;
        const textarea = textareaRef.current;
        const selection =
          isActive && textarea
            ? {
                start: transformIndex(remote, textarea.selectionStart),
                end: transformIndex(remote, textarea.selectionEnd),
              }
            : null;

        file.text = applyOp(file.text, remote);
        file.revision = message.revision;
        if (isActive) {
          pendingSelectionRef.current = selection;
          setCode(file.text);
        }
      } catch (error) {
        // Our copy has drifted from the server's; ask for the server's copy
        console.error('Could not apply remote edit, resyncing:', error);
        sendWsMessage({ type: 'SELECT_FILE', filePath: message.filePath });
      }
    },
    [sendWsMessage]
  );

  // Shows a file in the editor: straight away if we already hold it, otherwise
  // after requesting it. An empty path means no file is open.
  const showFile = useCallback(
    (filePath) => {
      activePathRef.current = filePath;
      setActiveFilePath(filePath);
      pendingSelectionRef.current = null;

      const file = filesRef.current.get(filePath);
      if (file) {
        setCode(file.text);
        setIsReady(true);
        setIsFileLoading(false);
        return;
      }
      setCode('');
      setIsReady(false);
      if (filePath) {
        setIsFileLoading(true);
        sendWsMessage({ type: 'SELECT_FILE', filePath });
      } else {
        setIsFileLoading(false);
      }
    },
    [sendWsMessage]
  );

  // Adopts a new tree from the server. Files are keyed by path, so a rename or
  // move would orphan their sync state: carry it across by node ID instead.
  const applyTreeUpdate = useCallback(
    (newTree) => {
      const oldPaths = treeRef.current
        ? getFilePathsById(treeRef.current)
        : new Map();
      const newPaths = getFilePathsById(newTree);
      treeRef.current = newTree;
      setTree(newTree);

      const carried = new Map();
      for (const [id, oldPath] of oldPaths) {
        const file = filesRef.current.get(oldPath);
        const newPath = newPaths.get(id);
        if (!file || !newPath) continue;

        // An edit still awaiting its ACK was sent to the old path, so the
        // server never saw it; fold it back into what is waiting to be sent
        if (file.outstanding) {
          file.buffer = file.buffer
            ? compose(file.outstanding, file.buffer)
            : file.outstanding;
          file.outstanding = null;
        }
        carried.set(newPath, file);
      }
      filesRef.current = carried;
      for (const filePath of carried.keys()) flushFile(filePath);

      // Follow the open file if it moved; fall back to another if it is gone
      const activePath = activePathRef.current;
      const activeId = [...oldPaths].find(
        ([, path]) => path === activePath
      )?.[0];
      const nextPath = activeId ? newPaths.get(activeId) : undefined;
      if (nextPath === activePath) return;
      showFile(nextPath ?? newPaths.values().next().value ?? '');
    },
    [flushFile, showFile]
  );

  // Applies a message from the server to local state
  const handleIncomingMessage = useCallback(
    (message) => {
      switch (message.type) {
        // Full room state on connect: show the active file, or request it if
        // the room doesn't have it yet
        case 'INIT_CODEBASE': {
          filesRef.current = new Map();
          treeRef.current = message.tree;
          setTree(message.tree);
          for (const [filePath, text] of Object.entries(message.files || {})) {
            resetFile(filePath, text, message.revisions?.[filePath] ?? 0);
          }
          // Open main.py, or whatever file is first if it was deleted
          if (!filesRef.current.has(activePathRef.current)) {
            showFile(filesRef.current.keys().next().value ?? '');
          }
          break;
        }

        // The room's file tree changed (by us or another user)
        case 'TREE_UPDATE':
          applyTreeUpdate(message.tree);
          break;

        // Authoritative copy of one file (response to SELECT_FILE, or sent
        // when the server couldn't reconcile our edit) - overwrites local text
        case 'FILE_SNAPSHOT':
          resetFile(message.filePath, message.code, message.revision);
          break;

        // Another user's edit, already rebased onto the server's history
        case 'TEXT_EDIT':
          applyRemoteEdit(message);
          break;

        // The server accepted our outstanding edit: it is now part of the
        // confirmed document, so send anything typed in the meantime
        case 'ACK': {
          const file = filesRef.current.get(message.filePath);
          if (!file?.outstanding) break;
          file.outstanding = null;
          file.revision = message.revision;
          flushFile(message.filePath);
          break;
        }

        // Output of a RUN_CODE request
        case 'RUN_RESULTS':
          setIsRunning(false);
          setTerminalOutput(getRunOutput(message));
          break;

        case 'SUBMISSION_UNAVAILABLE':
          setTerminalOutput(message.message);
          break;

        // A rejected edit would stay outstanding forever and block all further
        // syncing of that file, so drop our copy and fetch the server's
        case 'ERROR': {
          setTerminalOutput(`Editor error: ${message.error}`);
          setIsFileLoading(false);
          setIsRunning(false);
          const file = message.filePath
            ? filesRef.current.get(message.filePath)
            : null;
          if (file?.outstanding) {
            filesRef.current.delete(message.filePath);
            if (message.filePath === activePathRef.current) {
              showFile(message.filePath);
            }
          }
          break;
        }

        default:
          break;
      }
    },
    [applyRemoteEdit, applyTreeUpdate, flushFile, resetFile, showFile]
  );

  // Open the socket when the room/problem/url changes and close it on cleanup.
  // `active` guards against callbacks firing after the effect was cleaned up.
  useEffect(() => {
    let active = true;
    let socket;

    // Start every room from a clean slate so nothing from the previous room
    // can be edited (and then lost) while the new one connects
    filesRef.current = new Map();
    treeRef.current = null;
    pendingSelectionRef.current = null;
    activePathRef.current = DEFAULT_FILE;
    setTree(null);
    setCode('');
    setActiveFilePath(DEFAULT_FILE);
    setIsConnected(false);
    setIsReady(false);
    setIsRunning(false);
    setIsFileLoading(false);

    if (!activeRoomId) {
      setIsConnected(false);
      socketRef.current = null;
      return undefined;
    }

    try {
      socket = new WebSocket(getWebSocketUrl(wsUrl, activeRoomId, problemId));
    } catch (error) {
      setTerminalOutput(`Could not connect to the editor: ${error.message}`);
      return undefined;
    }

    socketRef.current = socket;

    socket.onopen = () => {
      if (!active) return;
      setIsConnected(true);
      setTerminalOutput(`Connected to shared room: ${activeRoomId}`);
      socket.send(JSON.stringify({ type: 'SYNC_INIT' }));
    };

    socket.onmessage = (event) => {
      if (!active) return;
      try {
        handleIncomingMessage(JSON.parse(event.data));
      } catch (error) {
        console.error('Failed to process WebSocket message:', error);
        setTerminalOutput(
          'Received an invalid response from the editor server.'
        );
      }
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      if (active) {
        setTerminalOutput(
          'WebSocket connection failed. Check the server and sign-in.'
        );
      }
    };

    socket.onclose = (event) => {
      if (!active) return;
      setIsConnected(false);
      setIsReady(false);
      setIsRunning(false);
      if (event.code === 4001) {
        setTerminalOutput(
          'Your sign-in has expired. Sign in again to use the editor.'
        );
        window.dispatchEvent(new Event('auth:expired'));
        return;
      }
      setTerminalOutput(
        event.reason
          ? `Disconnected from the editor server: ${event.reason}`
          : 'Disconnected from the editor server. Reload the page to reconnect.'
      );
    };

    return () => {
      active = false;
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [activeRoomId, handleIncomingMessage, problemId, wsUrl]);

  // Applies a local change immediately, then syncs it to the server.
  // `cursorPosition` restores the caret after React re-renders the textarea.
  const applyLocalEdit = (updatedCode, cursorPosition) => {
    const filePath = activePathRef.current;
    const file = filesRef.current.get(filePath);
    if (!file) return;

    if (updatedCode === file.text) return;
    // The change since the previous text, added to anything not yet sent
    const op = diffToOp(file.text, updatedCode);
    file.buffer = file.buffer ? compose(file.buffer, op) : op;
    file.text = updatedCode;
    setCode(updatedCode);
    flushFile(filePath);

    // Restored by the layout effect once React has written the new text
    if (cursorPosition !== undefined) {
      pendingSelectionRef.current = {
        start: cursorPosition,
        end: cursorPosition,
      };
    }
  };

  // Normal typing / pasting / deleting
  const handleInput = (event) => {
    applyLocalEdit(event.target.value);
  };

  // Switches the active file. Files we already hold are shown straight away
  // (the server's broadcasts keep them live); others are requested first.
  const handleSelectFile = useCallback(
    (filePath) => {
      if (filePath === activePathRef.current) return;
      showFile(filePath);
    },
    [showFile]
  );

  // Asks the server to create/rename/delete/move a file or folder; the change
  // appears when the server's TREE_UPDATE comes back
  const handleTreeOperation = useCallback(
    (operation) => {
      sendWsMessage({ type: 'TREE_OPERATION', operation });
    },
    [sendWsMessage]
  );

  // Python-friendly editing behaviour: Tab inserts 4 spaces, Backspace removes
  // a whole indent level, and Enter keeps (or adds/removes) indentation.
  const handleKeyDown = (event) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const { selectionStart, selectionEnd, value } = textarea;

    // Tab -> insert four spaces instead of moving focus
    if (event.key === 'Tab') {
      event.preventDefault();
      const indentation = '    ';
      const next =
        value.slice(0, selectionStart) +
        indentation +
        value.slice(selectionEnd);
      applyLocalEdit(next, selectionStart + indentation.length);
      return;
    }

    // Backspace with only an indent to the left of the cursor -> delete the
    // whole indent (4 spaces or one tab) rather than a single character
    if (
      event.key === 'Backspace' &&
      selectionStart === selectionEnd &&
      selectionStart > 0
    ) {
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const beforeCursor = value.slice(lineStart, selectionStart);
      if (/^(?: {4}|\t)$/.test(beforeCursor.slice(-4))) {
        event.preventDefault();
        const indentationLength = beforeCursor.endsWith('\t') ? 1 : 4;
        const next =
          value.slice(0, selectionStart - indentationLength) +
          value.slice(selectionEnd);
        applyLocalEdit(next, selectionStart - indentationLength);
        return;
      }
    }

    // Enter -> auto-indent: copy the current line's indentation, add a level
    // after a line ending in ':', and dedent for else/elif/except/finally/case
    if (
      event.key !== 'Enter' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();

    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const lineBeforeCursor = value.slice(lineStart, selectionStart);
    const indentation = lineBeforeCursor.match(/^[\t ]*/)?.[0] || '';
    const trimmedLine = lineBeforeCursor.trimStart();
    const dedent = /^(?:else|elif|except|finally|case)\b/.test(trimmedLine);
    const currentIndent = dedent
      ? indentation.slice(0, Math.max(0, indentation.length - 4))
      : indentation;
    const opensBlock = /:\s*(?:#.*)?$/.test(lineBeforeCursor);
    const nextIndent = currentIndent + (opensBlock && !dedent ? '    ' : '');
    const inserted = `\n${nextIndent}`;
    const next =
      value.slice(0, selectionStart) + inserted + value.slice(selectionEnd);
    applyLocalEdit(next, selectionStart + inserted.length);
  };

  // Asks the server to run the current file; the result arrives as RUN_RESULTS
  const handleRunCode = () => {
    const requestId = `run-${Date.now()}-${++requestCounterRef.current}`;
    if (
      sendWsMessage({
        type: 'RUN_CODE',
        requestId,
        filePath: activePathRef.current,
        code: filesRef.current.get(activePathRef.current)?.text ?? '',
      })
    ) {
      setIsRunning(true);
      setTerminalOutput('Running Python code...');
    }
  };

  // With no room there is no socket to report on, so say what is needed
  const statusText =
    activeRoomId || teamsLoading
      ? terminalOutput
      : teamsError
        ? 'Could not load your teams.'
        : 'You are not in a team yet. Create or join one on a group page to start coding.';

  return (
    <div className="editor page-enter">
      <header className="editor-header">
        <div className="editor-title">
          <p className="editor-brand">The Hackathon</p>
          <div className="editor-status">
            <span
              className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}
              aria-hidden="true"
            />
            <span role="status">
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
            <span className="room-label">
              Room: {activeRoomId || 'No team selected'}
            </span>
          </div>
          <div className="editor-team-selector">
            <label htmlFor="editor-team-select">Team: </label>

            <select
              id="editor-team-select"
              value={selectedTeamId}
              onChange={(event) => setSelectedTeamId(event.target.value)}
              disabled={teamsLoading || teams.length === 0}
              aria-label="Select collaboration team"
            >
              {teams.length === 0 && (
                <option value="">
                  {teamsLoading ? 'Loading teams...' : 'No teams available'}
                </option>
              )}

              {teams.map((team) => (
                <option key={team.id} value={String(team.id)}>
                  {team.name}
                </option>
              ))}
            </select>

            {teamsError && (
              <p role="alert" className="editor-team-error">
                {teamsError}
              </p>
            )}
          </div>
        </div>

        <div className="editor-actions">
          <button
            className="editor-btn editor-btn-primary"
            type="button"
            onClick={handleRunCode}
            disabled={!isReady || isRunning || isFileLoading}
          >
            {isRunning ? 'Running...' : 'Run Python'}
          </button>
          <button
            className="editor-btn"
            type="button"
            disabled
            title="Grading will be added later."
          >
            Submit solution (coming soon)
          </button>
        </div>
      </header>

      <div className="editor-body">
        <aside className="editor-sidebar">
          <FileTree
            tree={tree}
            onOperation={handleTreeOperation}
            onSelectFile={handleSelectFile}
            selectedPath={activeFilePath}
          />
        </aside>

        <main className="editor-workspace">
          <div className="active-tab">{activeFilePath || 'No file open'}</div>
          <textarea
            ref={textareaRef}
            value={code}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Write Python code here..."
            spellCheck={false}
            className="code-input"
            aria-label={`Python source code in ${activeFilePath}`}
            disabled={!isReady || isFileLoading}
          />
          <section className="terminal-panel" aria-label="Execution output">
            <div className="terminal-header">Python output</div>
            <pre className="terminal-content" role="status">
              {statusText}
            </pre>
          </section>
        </main>
      </div>
    </div>
  );
}
