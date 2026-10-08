import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import FileTree from '../FileTree/FileTree.jsx';
import { getToken } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
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
 * Props:
 *  - roomId:    room to join (falls back to ?roomId=, then the user's own room)
 *  - problemId: problem identifier sent to the server
 *  - wsUrl:     optional override of the WebSocket URL
 */
export default function CodeEditor({ roomId, problemId = 'prob-1', wsUrl }) {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const activeRoomId =
    roomId ||
    searchParams.get('roomId') ||
    (user ? `user-${user.id}` : 'default-room');
  // main.py is open as soon as the editor loads
  const [activeFilePath, setActiveFilePath] = useState(DEFAULT_FILE);
  const [code, setCode] = useState('');
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

  // Applies a message from the server to local state
  const handleIncomingMessage = useCallback(
    (message) => {
      switch (message.type) {
        // Full room state on connect: show the active file, or request it if
        // the room doesn't have it yet
        case 'INIT_CODEBASE': {
          filesRef.current = new Map();
          for (const [filePath, text] of Object.entries(message.files || {})) {
            resetFile(filePath, text, message.revisions?.[filePath] ?? 0);
          }
          if (!filesRef.current.has(activePathRef.current)) {
            socketRef.current?.send(
              JSON.stringify({
                type: 'SELECT_FILE',
                filePath: activePathRef.current,
              })
            );
            setIsFileLoading(true);
          }
          break;
        }

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

        case 'ERROR':
          setTerminalOutput(`Editor error: ${message.error}`);
          setIsFileLoading(false);
          break;

        default:
          break;
      }
    },
    [applyRemoteEdit, flushFile, resetFile]
  );

  // Open the socket when the room/problem/url changes and close it on cleanup.
  // `active` guards against callbacks firing after the effect was cleaned up.
  useEffect(() => {
    let active = true;
    let socket;

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
      setTerminalOutput(
        event.code === 4001
          ? 'Your sign-in has expired. Sign in again to use the editor.'
          : 'Disconnected from the editor server.'
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

    if (cursorPosition !== undefined) {
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(cursorPosition, cursorPosition);
      });
    }
  };

  // Normal typing / pasting / deleting
  const handleInput = (event) => {
    applyLocalEdit(event.target.value);
  };

  // Switches the active file. Files we already hold are shown straight away
  // (the server's broadcasts keep them live); others are requested first.
  const handleSelectFile = (filePath) => {
    if (filePath === activePathRef.current) return;
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
    setIsFileLoading(true);
    sendWsMessage({ type: 'SELECT_FILE', filePath });
  };

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
    if (event.key !== 'Enter') return;
    event.preventDefault();

    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const lineBeforeCursor = value.slice(lineStart, selectionStart);
    const indentation = lineBeforeCursor.match(/^[\t ]*/)?.[0] || '';
    const trimmedLine = lineBeforeCursor.trimStart();
    const dedent = /^(?:else|elif\b|except\b|finally\b|case\b)/.test(
      trimmedLine
    );
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
            <span className="room-label">Room: {activeRoomId}</span>
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
            onSelectFile={handleSelectFile}
            selectedPath={activeFilePath}
          />
        </aside>

        <main className="editor-workspace">
          <div className="active-tab">{activeFilePath}</div>
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
              {terminalOutput}
            </pre>
          </section>
        </main>
      </div>
    </div>
  );
}
