import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './ProblemsPanel.css';

// Problems and test cases (spec section 6).
// The admin edits them before the event; members see them once it starts.
export default function ProblemsPanel({ group }) {
  const [problems, setProblems] = useState(null); // null = loading
  const [revealed, setRevealed] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  // Which problem is open: a problem id, 'new' (the add form) or null. Only
  // one thing is open at a time, so opening one collapses the other.
  const [expandedId, setExpandedId] = useState(null);

  const canEdit = group.isAdmin && group.status === 'not-started';

  // Reload the whole list after any change, so orderIndex stays correct.
  async function reload() {
    try {
      const data = await api(`/groups/${group.id}/problems`);
      setRevealed(data.revealed);
      setProblems(data.problems);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, group.status]);

  async function addProblem(e) {
    e.preventDefault();
    const form = new FormData(e.target);
    setError('');
    setAdding(true);
    try {
      await api(`/groups/${group.id}/problems`, {
        method: 'POST',
        body: {
          title: form.get('title'),
          description: form.get('description'),
          inputFormat: form.get('inputFormat'),
          outputFormat: form.get('outputFormat'),
          submissionLimit: Number(form.get('submissionLimit') || 0),
        },
      });
      e.target.reset();
      await reload();
      setExpandedId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="panel">
      <div className="problems-heading">
        <h2>Problems</h2>
        {canEdit && (
          <button
            className="btn-primary"
            type="button"
            onClick={() => setExpandedId(expandedId === 'new' ? null : 'new')}
          >
            {expandedId === 'new' ? 'Cancel' : 'New problem'}
          </button>
        )}
      </div>

      {!group.isAdmin && !revealed && (
        <p className="form-hint">
          Problems are revealed when the admin starts the event.
        </p>
      )}
      {group.isAdmin && group.status !== 'not-started' && (
        <p className="form-hint">Problems are locked once the event starts.</p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!problems && !error && <p className="muted">Loading problems…</p>}

      {problems?.length === 0 && revealed && (
        <p className="form-hint">
          {group.isAdmin
            ? 'No problems yet. Use New problem to add the first one.'
            : 'The admin has not added any problems.'}
        </p>
      )}

      {problems?.length > 0 && (
        <ol className="problem-list">
          {problems.map((problem, i) => (
            <ProblemCard
              key={problem.id}
              problem={problem}
              groupId={group.id}
              canEdit={canEdit}
              isFirst={i === 0}
              isLast={i === problems.length - 1}
              expanded={expandedId === problem.id}
              onToggle={() =>
                setExpandedId(expandedId === problem.id ? null : problem.id)
              }
              onChanged={reload}
            />
          ))}
        </ol>
      )}

      {canEdit && expandedId === 'new' && (
        <form className="problem-add" onSubmit={addProblem}>
          <h3>Add a problem</h3>
          <label>
            Title
            <input name="title" required maxLength={100} />
          </label>
          <label>
            Description
            <textarea name="description" required rows={3} />
          </label>
          <div className="settings-grid">
            <label>
              Input format (stdin)
              <textarea name="inputFormat" rows={2} />
            </label>
            <label>
              Output format (stdout)
              <textarea name="outputFormat" rows={2} />
            </label>
          </div>
          <label className="narrow">
            Submission limit per team (0 = unlimited)
            <input
              name="submissionLimit"
              type="number"
              min={0}
              max={1000}
              defaultValue={0}
            />
          </label>
          <button className="btn-primary" type="submit" disabled={adding}>
            {adding ? 'Adding…' : 'Add problem'}
          </button>
        </form>
      )}
    </div>
  );
}

function ProblemCard({
  problem,
  groupId,
  canEdit,
  isFirst,
  isLast,
  expanded,
  onToggle,
  onChanged,
}) {
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  // Test cases are never shown by default: collapsing the problem hides them,
  // so the next time it is expanded they start hidden again
  if (!expanded && open) setOpen(false);

  async function act(path, options) {
    setError('');
    try {
      await api(path, options);
      await onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  const base = `/groups/${groupId}/problems/${problem.id}`;

  return (
    <li className="problem-card">
      <div className="problem-head">
        <button
          type="button"
          className="problem-title"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="problem-chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="problem-title-text">{problem.title}</span>
        </button>
        {canEdit && (
          <span className="problem-actions">
            <button
              className="link-button"
              disabled={isFirst}
              onClick={() =>
                act(`${base}/move`, {
                  method: 'POST',
                  body: { direction: 'up' },
                })
              }
            >
              ↑
            </button>
            <button
              className="link-button"
              disabled={isLast}
              onClick={() =>
                act(`${base}/move`, {
                  method: 'POST',
                  body: { direction: 'down' },
                })
              }
            >
              ↓
            </button>
            <button
              className="problem-pill danger"
              onClick={() => {
                if (
                  window.confirm(
                    `Delete "${problem.title}" and its test cases?`
                  )
                ) {
                  act(base, { method: 'DELETE' });
                }
              }}
            >
              Delete
            </button>
          </span>
        )}
      </div>

      <Collapsible open={expanded}>
        <div className="problem-body">
          <section className="problem-section">
            <h4 className="problem-label">Description</h4>
            <p className="problem-desc">{problem.description}</p>
          </section>

          {(problem.inputFormat || problem.outputFormat) && (
            <dl className="problem-formats problem-section">
              {problem.inputFormat && (
                <div>
                  <dt>Input (stdin)</dt>
                  <dd>{problem.inputFormat}</dd>
                </div>
              )}
              {problem.outputFormat && (
                <div>
                  <dt>Output (stdout)</dt>
                  <dd>{problem.outputFormat}</dd>
                </div>
              )}
            </dl>
          )}

          <div className="problem-footer">
            <span className="problem-limit">
              {problem.submissionLimit > 0
                ? `Up to ${problem.submissionLimit} submissions per team`
                : 'Unlimited submissions'}
            </span>

            <button
              type="button"
              className="problem-pill"
              onClick={() => setOpen(!open)}
            >
              {open ? 'Hide' : 'Show'} test cases ({problem.testCases.length}
              {problem.hiddenTestCount > 0
                ? ` + ${problem.hiddenTestCount} hidden`
                : ''}
              )
            </button>
          </div>

          <Collapsible open={open}>
            <TestCases
              problem={problem}
              groupId={groupId}
              canEdit={canEdit}
              onChanged={onChanged}
            />
          </Collapsible>
        </div>
      </Collapsible>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

// Animates its content open and closed. The content stays mounted so it can
// slide shut; the CSS also hides it from keyboard and screen readers when closed.
function Collapsible({ open, children }) {
  return (
    <div className={`collapsible${open ? ' open' : ''}`}>
      <div className="collapsible-inner">{children}</div>
    </div>
  );
}

function TestCases({ problem, groupId, canEdit, onChanged }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/groups/${groupId}/problems/${problem.id}/tests`;

  async function addTest(e) {
    e.preventDefault();
    const form = new FormData(e.target);
    setError('');
    setBusy(true);
    try {
      await api(base, {
        method: 'POST',
        body: {
          input: form.get('input'),
          expectedOutput: form.get('expectedOutput'),
          timeLimit: Number(form.get('timeLimit') || 5000),
          hidden: form.get('hidden') === 'on',
        },
      });
      e.target.reset();
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeTest(id) {
    setError('');
    try {
      await api(`${base}/${id}`, { method: 'DELETE' });
      await onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="test-block">
      {problem.hiddenTestCount > 0 && !canEdit && (
        <p className="form-hint">
          {problem.hiddenTestCount} hidden test case
          {problem.hiddenTestCount === 1 ? '' : 's'} are not shown.
        </p>
      )}

      {problem.testCases.length > 0 && (
        <table className="test-table">
          <thead>
            <tr>
              <th>Input</th>
              <th>Expected output</th>
              <th>Limit</th>
              <th>Hidden</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {problem.testCases.map((t) => (
              <tr key={t.id}>
                <td>
                  <pre>{t.input}</pre>
                </td>
                <td>
                  <pre>{t.expectedOutput}</pre>
                </td>
                <td>{t.timeLimit} ms</td>
                <td>{t.hidden ? 'Yes' : 'No'}</td>
                {canEdit && (
                  <td>
                    <button
                      type="button"
                      className="problem-pill danger"
                      onClick={() => removeTest(t.id)}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit && (
        <form className="test-add" onSubmit={addTest}>
          <label>
            Input
            <textarea name="input" rows={2} required />
          </label>
          <label>
            Expected output
            <textarea name="expectedOutput" rows={2} required />
          </label>
          <label className="narrow">
            Runtime limit (ms)
            <input
              name="timeLimit"
              type="number"
              min={100}
              max={60000}
              defaultValue={5000}
            />
          </label>
          <label className="checkbox">
            <input name="hidden" type="checkbox" />
            Hidden (only pass or fail is shown to teams)
          </label>
          <button className="btn-secondary" type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add test case'}
          </button>
        </form>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
