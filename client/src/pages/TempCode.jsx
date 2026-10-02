import { useState } from 'react';

export default function TempCode() {
  const [code, setCode] = useState(
    '// Write your solution here...\n\nfunction solve() {\n  return "Hello, Hackathon!";\n}'
  );
  const [language, setLanguage] = useState('javascript');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleRunCode(e) {
    e.preventDefault();
    setError('');
    setOutput('');
    setBusy(true);

    try {
      // Placeholder execution simulation
      await new Promise((resolve) => setTimeout(resolve, 1000));
      setOutput('Success (0ms):\nOutput: Hello, Hackathon!');
    } catch (err) {
      setError(err.message || 'Execution failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="editor-page">
      <div className="editor-panel">
        <p className="editor-brand">The Hackathon</p>
        <h1>Workspace & Code Editor</h1>
        <p className="editor-lead">
          Write, test, and preview your problem submissions.
        </p>

        <form className="editor-form" onSubmit={handleRunCode} noValidate>
          <div className="editor-controls">
            <label>
              Language
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="javascript">JavaScript</option>
                <option value="python">Python</option>
                <option value="html">HTML / CSS</option>
              </select>
            </label>
          </div>

          <label>
            Source Code
            <textarea
              className="editor-textarea"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              rows={12}
              spellCheck={false}
              required
            />
          </label>

          {error && (
            <p className="editor-error" role="alert">
              {error}
            </p>
          )}

          <div className="editor-actions">
            <button
              className="editor-submit"
              type="submit"
              disabled={busy || !code.trim()}
            >
              {busy ? 'Running…' : 'Run Code'}
            </button>
          </div>
        </form>

        {output && (
          <div className="editor-output-box">
            <label>Output Console</label>
            <pre className="editor-output">{output}</pre>
          </div>
        )}
      </div>
    </main>
  );
}
