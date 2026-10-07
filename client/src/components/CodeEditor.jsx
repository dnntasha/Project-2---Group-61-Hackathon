import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import FileTree from './FileTree/FileTree.jsx';
import { getToken } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import './CodeEditor.css';

function getWebSocketUrl(wsUrl, roomId, problemId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(wsUrl || `${protocol}//${window.location.host}/ws`);
  const token = getToken();

  if (token) url.searchParams.set('token', token);
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('problemId', problemId);
  return url.toString();
}

function getTextEdit(previous, next) {
  let start = 0;
  while (
    start < previous.length &&
    start < next.length &&
    previous[start] === next[start]
  ) {
    start += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previous.length - start &&
    suffixLength < next.length - start &&
    previous[previous.length - suffixLength - 1] ===
      next[next.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  return {
    index: start,
    inserted: next.slice(start, next.length - suffixLength),
    deletedCount: previous.length - start - suffixLength,
  };
}

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

export default function CodeEditor({ roomId, problemId = 'prob-1', wsUrl }) {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const activeRoomId =
    roomId ||
    searchParams.get('roomId') ||
    (user ? `user-${user.id}` : 'default-room');
  const [activeFilePath, setActiveFilePath] = useState('main.py');
  const [code, setCode] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState(
    'Connecting to the shared Python workspace...'
  );

  const textareaRef = useRef(null);
  const socketRef = useRef(null);
  const codeRef = useRef(code);
  const activePathRef = useRef(activeFilePath);
  const revisionsRef = useRef(new Map());
  const requestCounterRef = useRef(0);

  codeRef.current = code;
  activePathRef.current = activeFilePath;

  const handleIncomingMessage = useCallback((message) => {
    switch (message.type) {
      case 'INIT_CODEBASE': {
        const revisions = new Map(Object.entries(message.revisions || {}));
        revisionsRef.current = revisions;
        const currentPath = activePathRef.current;
        if (message.files?.[currentPath] !== undefined) {
          codeRef.current = message.files[currentPath];
          setCode(message.files[currentPath]);
          setIsReady(true);
        } else {
          socketRef.current?.send(
            JSON.stringify({ type: 'SELECT_FILE', filePath: currentPath })
          );
          setIsFileLoading(true);
        }
        break;
      }

      case 'FILE_SNAPSHOT':
        revisionsRef.current.set(message.filePath, message.revision);
        if (message.filePath === activePathRef.current) {
          codeRef.current = message.code;
          setCode(message.code);
          setIsReady(true);
          setIsFileLoading(false);
        }
        break;

      case 'TEXT_EDIT': {
        const currentRevision = revisionsRef.current.get(message.filePath) ?? 0;
        if (message.revision !== currentRevision + 1) {
          socketRef.current?.send(
            JSON.stringify({
              type: 'SELECT_FILE',
              filePath: message.filePath,
            })
          );
          break;
        }
        revisionsRef.current.set(message.filePath, message.revision);
        if (message.filePath === activePathRef.current) {
          const updatedCode =
            codeRef.current.slice(0, message.index) +
            message.inserted +
            codeRef.current.slice(message.index + message.deletedCount);
          codeRef.current = updatedCode;
          setCode(updatedCode);
        }
        break;
      }

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
  }, []);

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

  const sendWsMessage = (payload) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
      return true;
    }
    setTerminalOutput(
      'Not connected. Reconnect before editing or running code.'
    );
    return false;
  };

  const applyLocalEdit = (updatedCode, cursorPosition) => {
    const previousCode = codeRef.current;
    const edit = getTextEdit(previousCode, updatedCode);
    const filePath = activePathRef.current;
    const baseRevision = revisionsRef.current.get(filePath) ?? 0;

    codeRef.current = updatedCode;
    setCode(updatedCode);
    const sent = sendWsMessage({
      type: 'TEXT_EDIT',
      filePath,
      ...edit,
      baseRevision,
    });
    if (sent) revisionsRef.current.set(filePath, baseRevision + 1);

    if (cursorPosition !== undefined) {
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(cursorPosition, cursorPosition);
      });
    }
  };

  const handleInput = (event) => {
    applyLocalEdit(event.target.value);
  };

  const handleSelectFile = (filePath) => {
    if (filePath === activePathRef.current) return;
    activePathRef.current = filePath;
    setActiveFilePath(filePath);
    setCode('');
    codeRef.current = '';
    setIsReady(false);
    setIsFileLoading(true);
    sendWsMessage({ type: 'SELECT_FILE', filePath });
  };

  const handleKeyDown = (event) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const { selectionStart, selectionEnd, value } = textarea;

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

  const handleRunCode = () => {
    const requestId = `run-${Date.now()}-${++requestCounterRef.current}`;
    if (
      sendWsMessage({
        type: 'RUN_CODE',
        requestId,
        filePath: activePathRef.current,
        code: codeRef.current,
      })
    ) {
      setIsRunning(true);
      setTerminalOutput('Running Python code...');
    }
  };

  return (
    <div className="editor-container">
      <header className="editor-header">
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

        <div className="editor-actions">
          <button
            className="action-btn run-btn"
            type="button"
            onClick={handleRunCode}
            disabled={!isReady || isRunning || isFileLoading}
          >
            {isRunning ? 'Running...' : 'Run Python'}
          </button>
          <button
            className="action-btn submit-btn"
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
          <FileTree onSelectFile={handleSelectFile} />
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
