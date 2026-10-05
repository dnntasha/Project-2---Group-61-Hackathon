import React, { useState, useEffect, useRef, useCallback } from 'react';
//import { useAuth } from '../auth/AuthContext.jsx';
import FileTree from './FileTree/FileTree.jsx';
import './CodeEditor.css';

export default function CodeEditor({
  roomId = 'default-room',
  problemId = 'prob-1',
  // Default to unencrypted ws for local testing unless explicitly wss
  wsUrl = 'ws://localhost:5000/ws',
}) {
  //const { user } = useAuth();

  // Editor & Workspace State
  const [fileSystem, setFileSystem] = useState([]);
  const [activeFilePath, setActiveFilePath] = useState('main.py');
  const [code, setCode] = useState(
    'def main():\n    print("Hello, Hackathon!")\n\nif __name__ == "__main__":\n    main()'
  );
  const [isConnected, setIsConnected] = useState(false);

  // Execution & Submission State
  const [isRunning, setIsRunning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState(
    'System ready. Click "Run Code" to test execution.'
  );

  const textareaRef = useRef(null);
  const socketRef = useRef(null);
  const codeRef = useRef(code);
  codeRef.current = code;

  const activePathRef = useRef(activeFilePath);
  activePathRef.current = activeFilePath;

  // 1. Establish WebSocket Connection
  useEffect(() => {
    if (!roomId) return;

    // Construct valid WebSocket URL with room context
    const fullWsUrl = `${wsUrl}?roomId=${encodeURIComponent(roomId)}&problemId=${encodeURIComponent(problemId)}`;
    const ws = new WebSocket(fullWsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setTerminalOutput(
        (prev) => `${prev}\n[WS] Connected to live room: ${roomId}`
      );
      ws.send(JSON.stringify({ type: 'SYNC_INIT', roomId, problemId }));
    };

    ws.onclose = () => {
      setIsConnected(false);
      setTerminalOutput((prev) => `${prev}\n[WS] Disconnected from server.`);
    };

    ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
      setIsConnected(false);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleIncomingMessage(message);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    return () => {
      ws.close();
    };
  }, [roomId, problemId, wsUrl]);

  // 2. Handle Server Payload Responses
  const handleIncomingMessage = useCallback((message) => {
    switch (message.type) {
      case 'INIT_CODEBASE':
        if (message.fileTree) setFileSystem(message.fileTree);
        if (
          message.files &&
          message.files[activePathRef.current] !== undefined
        ) {
          setCode(message.files[activePathRef.current]);
        }
        break;

      case 'TEXT_EDIT':
        if (message.filePath === activePathRef.current) {
          applyRemoteChange(message);
        }
        break;

      case 'RUN_RESULTS':
        setIsRunning(false);
        setTerminalOutput(
          `--- RUN OUTPUT ---\nstdout:\n${message.stdout || '(no output)'}\n\nstderr:\n${message.stderr || '(none)'}\nExit Code: ${message.exitCode}`
        );
        break;

      case 'SUBMISSION_RESULTS':
        setIsSubmitting(false);
        setTerminalOutput(
          `--- TEST EVALUATION ---\nPassed: ${message.passedCount}/${message.totalTests}\nScore: ${message.score}\nRuntime: ${message.totalRuntime}ms`
        );
        break;

      default:
        break;
    }
  }, []);

  const applyRemoteChange = ({ index, inserted = '', deletedCount = 0 }) => {
    const textarea = textareaRef.current;

    setCode(
      (prev) =>
        prev.slice(0, index) + inserted + prev.slice(index + deletedCount)
    );

    if (!textarea) return;
  };

  const sendWsMessage = (payload) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
    }
  };

  const handleInput = (e) => {
    const newValue = e.target.value;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const selectionStart = textarea.selectionStart;
    const prevCode = codeRef.current;
    const diffLen = newValue.length - prevCode.length;

    let editIndex = selectionStart - Math.max(0, diffLen);
    let inserted = '';
    let deletedCount = 0;

    if (diffLen > 0) {
      inserted = newValue.slice(editIndex, editIndex + diffLen);
    } else if (diffLen < 0) {
      deletedCount = Math.abs(diffLen);
    }

    setCode(newValue);

    sendWsMessage({
      type: 'TEXT_EDIT',
      roomId,
      filePath: activeFilePath,
      index: editIndex,
      inserted,
      deletedCount,
    });
  };

  const handleKeyDown = (e) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const { selectionStart, selectionEnd, value } = textarea;

    if (e.key === 'Tab') {
      e.preventDefault();
      const tabSpaces = '    ';
      const updatedValue =
        value.substring(0, selectionStart) +
        tabSpaces +
        value.substring(selectionEnd);
      setCode(updatedValue);

      sendWsMessage({
        type: 'TEXT_EDIT',
        roomId,
        filePath: activeFilePath,
        index: selectionStart,
        inserted: tabSpaces,
        deletedCount: selectionEnd - selectionStart,
      });
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const lastLineBreak = value.lastIndexOf('\n', selectionStart - 1);
      const currentLine = value.substring(lastLineBreak + 1, selectionStart);
      const match = currentLine.match(/^[\t ]*/);
      const currentIndent = match ? match[0] : '';
      const insertText = '\n' + currentIndent;

      setCode(
        value.substring(0, selectionStart) +
          insertText +
          value.substring(selectionEnd)
      );

      sendWsMessage({
        type: 'TEXT_EDIT',
        roomId,
        filePath: activeFilePath,
        index: selectionStart,
        inserted: insertText,
        deletedCount: selectionEnd - selectionStart,
      });
    }
  };

  // Action: Run local code for quick testing
  const handleRunCode = () => {
    setIsRunning(true);
    setTerminalOutput('Executing code on server...');
    sendWsMessage({
      type: 'RUN_CODE',
      roomId,
      filePath: activeFilePath,
      code,
    });
  };

  // Action: Full test suite evaluation submission[cite: 10, 11]
  const handleSubmitSolution = () => {
    setIsSubmitting(true);
    setTerminalOutput('Submitting codebase for full grading...');
    sendWsMessage({
      type: 'SUBMIT_SOLUTION',
      roomId,
      problemId,
    });
  };

  return (
    <div className="editor-container">
      {/* Top Header Bar */}
      <header className="editor-header">
        <div className="editor-status">
          <span
            className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}
          />
          <span>
            {isConnected ? 'Connected' : 'Disconnected (Check Port / Server)'}
          </span>
          <span className="room-label">Room: {roomId}</span>
        </div>

        <div className="editor-actions">
          <button
            className="action-btn run-btn"
            onClick={handleRunCode}
            disabled={!isConnected || isRunning}
          >
            {isRunning ? 'Running...' : '▶ Run Code'}
          </button>

          <button
            className="action-btn submit-btn"
            onClick={handleSubmitSolution}
            disabled={!isConnected || isSubmitting}
          >
            {isSubmitting ? 'Submitting...' : 'Submit Solution'}
          </button>
        </div>
      </header>

      {/* Main Workspace Area */}
      <div className="editor-body">
        <aside className="editor-sidebar">
          <FileTree
            fileTree={fileSystem}
            activeFile={activeFilePath}
            onSelectFile={(path) => setActiveFilePath(path)}
          />
        </aside>

        <main className="editor-workspace">
          <div className="active-tab">{activeFilePath}</div>
          <textarea
            ref={textareaRef}
            value={code}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="# Write Python code here..."
            spellCheck="false"
            className="code-input"
          />

          {/* Terminal / Output View */}
          <div className="terminal-panel">
            <div className="terminal-header">Execution Console / Output</div>
            <pre className="terminal-content">{terminalOutput}</pre>
          </div>
        </main>
      </div>
    </div>
  );
}
