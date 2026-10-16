import './SubmissionTimeline.css';

function formatRuntime(runtimeMs) {
  if (typeof runtimeMs !== 'number') {
    return '—';
  }

  return `${runtimeMs.toFixed(2)} ms`;
}

function formatDate(timestamp) {
  if (!timestamp) {
    return 'Unknown time';
  }

  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return date.toLocaleString();
}

export default function SubmissionTimeline({
  submissions = [],
  onSelect,
  selectedId,
}) {
  return (
    <section className="submission-timeline">
      <div className="timeline-heading">
        <div>
          <h2>Submission Timeline</h2>
          <p>Previous submissions for this problem</p>
        </div>

        <span className="submission-count">
          {submissions.length} submission{submissions.length === 1 ? '' : 's'}
        </span>
      </div>

      {submissions.length === 0 ? (
        <div className="timeline-empty">
          <p>No submissions yet.</p>
        </div>
      ) : (
        <ol className="timeline-list">
          {submissions.map((submission, index) => {
            const passed =
              submission.passed ?? submission.evaluation?.passed ?? false;

            const statusText =
              submission.status === 'PENDING'
                ? 'Grading...'
                : submission.status === 'FAILED'
                  ? 'Not graded'
                  : passed
                    ? 'Accepted'
                    : 'Failed';

            const passedTests =
              submission.passedTests ?? submission.evaluation?.passedTests ?? 0;

            const totalTests =
              submission.totalTests ?? submission.evaluation?.totalTests ?? 0;

            const P =
              submission.P ??
              submission.score?.P ??
              submission.evaluation?.passPercentage;

            const T =
              submission.T ??
              submission.score?.T ??
              submission.evaluation?.totalPassedRuntimeMs;

            return (
              <li
                className={`timeline-item ${
                  passed ? 'timeline-passed' : 'timeline-failed'
                }${submission.id === selectedId ? ' timeline-selected' : ''}`}
                key={submission.id ?? `${submission.timestamp}-${index}`}
              >
                <div className="timeline-marker" aria-hidden="true" />

                <article className="timeline-card">
                  <div className="timeline-card-header">
                    <div>
                      <strong>Submission {submissions.length - index}</strong>
                      <span className="timeline-time">
                        {formatDate(submission.timestamp)}
                      </span>
                    </div>

                    <span className="timeline-status">{statusText}</span>
                  </div>

                  <div className="timeline-stats">
                    <div>
                      <span>Tests</span>
                      <strong>
                        {passedTests}/{totalTests}
                      </strong>
                    </div>

                    <div>
                      <span>P</span>
                      <strong>
                        {typeof P === 'number' ? `${P.toFixed(2)}%` : '—'}
                      </strong>
                    </div>

                    <div>
                      <span>T</span>
                      <strong>{formatRuntime(T)}</strong>
                    </div>
                  </div>
                  {onSelect && (
                    <button
                      type="button"
                      className="timeline-view"
                      onClick={() => onSelect(submission)}
                      aria-pressed={submission.id === selectedId}
                    >
                      View report
                    </button>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
