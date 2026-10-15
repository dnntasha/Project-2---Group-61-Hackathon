import './ResponseArea.css';

function formatRuntime(runtimeMs) {
  if (typeof runtimeMs !== 'number') {
    return '—';
  }

  return `${runtimeMs.toFixed(2)} ms`;
}

function TestResult({ result, index }) {
  return (
    <article
      className={`test-result ${result.passed ? 'test-passed' : 'test-failed'}`}
    >
      <div className="test-result-header">
        <div>
          <strong>Test {index + 1}</strong>
          {result.hidden && <span className="hidden-badge">Hidden</span>}
        </div>

        <span className="test-status">
          {result.passed ? 'Passed' : 'Failed'}
        </span>
      </div>

      <div className="test-runtime">
        Runtime: {formatRuntime(result.runtimeMs)}
      </div>

      {!result.passed && result.reason && (
        <p className="failure-reason">{result.reason}</p>
      )}

      {!result.hidden && !result.passed && result.input !== undefined && (
        <div className="test-details">
          <div>
            <span className="detail-label">Input</span>
            <pre>{result.input || '(empty)'}</pre>
          </div>

          {result.expectedOutput !== undefined && (
            <div>
              <span className="detail-label">Expected output</span>
              <pre>{result.expectedOutput || '(empty)'}</pre>
            </div>
          )}

          {result.actualOutput !== undefined && (
            <div>
              <span className="detail-label">Your output</span>
              <pre>{result.actualOutput || '(empty)'}</pre>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function ResponseArea({ submission }) {
  if (!submission) {
    return (
      <section className="response-area">
        <div className="response-empty">
          <h2>Submission Results</h2>
          <p>Submit your solution to see the test results here.</p>
        </div>
      </section>
    );
  }

  const evaluation = submission.evaluation;

  if (!evaluation) {
    return (
      <section className="response-area">
        <div className="response-error">
          <h2>Submission Results</h2>
          <p>{submission.error ?? 'The submission could not be evaluated.'}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="response-area">
      <div className="response-heading">
        <div>
          <h2>Submission Results</h2>
          <p>
            {evaluation.passedTests} of {evaluation.totalTests} tests passed
          </p>
        </div>

        <span
          className={`submission-status ${
            evaluation.passed ? 'submission-passed' : 'submission-failed'
          }`}
        >
          {evaluation.passed ? 'Accepted' : 'Failed'}
        </span>
      </div>

      <div className="score-summary">
        <div>
          <span>Tests passed</span>
          <strong>
            {evaluation.passedTests}/{evaluation.totalTests}
          </strong>
        </div>

        <div>
          <span>Score P</span>
          <strong>{evaluation.passPercentage.toFixed(2)}%</strong>
        </div>

        <div>
          <span>Runtime T</span>
          <strong>{formatRuntime(evaluation.totalPassedRuntimeMs)}</strong>
        </div>
      </div>

      {evaluation.reason && (
        <p className="evaluation-reason">{evaluation.reason}</p>
      )}

      <div className="test-results">
        {evaluation.results.map((result, index) => (
          <TestResult
            key={`${index}-${result.hidden}-${result.runtimeMs}`}
            result={result}
            index={index}
          />
        ))}
      </div>
    </section>
  );
}
