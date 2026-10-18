import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './LeaderboardPage.css';

export default function LeaderboardPage() {
  // Groups the signed-in user belongs to
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');

  // Problems for the selected group
  const [problems, setProblems] = useState([]);
  const [viewType, setViewType] = useState('problem');
  const [problemId, setProblemId] = useState('');

  // Current leaderboard data returned by the server
  const [leaderboard, setLeaderboard] = useState(null);

  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingProblems, setLoadingProblems] = useState(false);
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);

  const [error, setError] = useState('');

  const selectedGroup = groups.find(
    (group) => String(group.id) === String(groupId)
  );

  const finalAvailable = hasEventEnded(selectedGroup);

  // Load the user's groups when the page opens
  useEffect(() => {
    api('/groups')
      .then((data) => {
        const userGroups = data.groups || [];

        setGroups(userGroups);

        if (userGroups.length > 0) {
          const firstGroup = userGroups[0];

          setGroupId(String(firstGroup.id));

          // Final leaderboard only becomes the default once the event ends
          setViewType(hasEventEnded(firstGroup) ? 'final' : 'problem');
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingGroups(false));
  }, []);

  // Load problems whenever the selected group changes
  useEffect(() => {
    if (!groupId) {
      setProblems([]);
      setProblemId('');
      return;
    }

    setLoadingProblems(true);

    api(`/groups/${groupId}/problems`)
      .then((data) => {
        const groupProblems = data.problems || [];

        setProblems(groupProblems);

        // Select the first problem by default
        if (groupProblems.length > 0) {
          setProblemId(String(groupProblems[0].id));
        } else {
          setProblemId('');
        }
      })
      .catch(() => {
        setProblems([]);
        setProblemId('');
      })
      .finally(() => setLoadingProblems(false));
  }, [groupId]);

  // Load either the final leaderboard or a problem leaderboard
  useEffect(() => {
    if (!groupId) {
      setLeaderboard(null);
      return;
    }

    if (viewType === 'problem' && !problemId) {
      setLeaderboard(null);
      return;
    }

    // Do not request the final leaderboard before the event ends
    if (viewType === 'final' && !finalAvailable) {
      setLeaderboard(null);
      return;
    }

    setError('');
    setLoadingLeaderboard(true);

    const path =
      viewType === 'final'
        ? `/leaderboards/groups/${groupId}/final`
        : `/leaderboards/groups/${groupId}/problems/${problemId}`;

    api(path)
      .then((data) => setLeaderboard(data))
      .catch((err) => {
        setLeaderboard(null);
        setError(err.message);
      })
      .finally(() => setLoadingLeaderboard(false));
  }, [groupId, viewType, problemId, finalAvailable]);

  function handleGroupChange(e) {
    const newGroupId = e.target.value;

    setGroupId(newGroupId);

    const newGroup = groups.find(
      (group) => String(group.id) === String(newGroupId)
    );

    // Problem leaderboard is shown until the event has ended
    setViewType(hasEventEnded(newGroup) ? 'final' : 'problem');
    setLeaderboard(null);
    setError('');
  }

  return (
    <main className="leaderboard-page page-enter">
      <div className="leaderboard-container">
        <header className="leaderboard-header">
          <h1>Leaderboard</h1>
          <p>
            View final and problem-specific rankings for each hackathon group.
          </p>
        </header>

        {/* Leaderboard filters */}
        <section className="leaderboard-panel">
          <div className="leaderboard-controls">
            <label className="leaderboard-group-select">
              Group
              <select
                value={groupId}
                onChange={handleGroupChange}
                disabled={loadingGroups || groups.length === 0}
              >
                {groups.length === 0 && (
                  <option value="">No groups available</option>
                )}

                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="leaderboard-group-select">
              Leaderboard
              <select
                value={viewType}
                onChange={(e) => {
                  setViewType(e.target.value);
                  setLeaderboard(null);
                  setError('');
                }}
                disabled={!groupId}
              >
                <option value="problem">Problem leaderboard</option>

                <option value="final" disabled={!finalAvailable}>
                  {finalAvailable
                    ? 'Final leaderboard'
                    : 'Final leaderboard (available after event)'}
                </option>
              </select>
            </label>

            {/* Only show the problem selector for a problem leaderboard */}
            {viewType === 'problem' && (
              <label className="leaderboard-group-select">
                Problem
                <select
                  value={problemId}
                  onChange={(e) => setProblemId(e.target.value)}
                  disabled={loadingProblems || problems.length === 0}
                >
                  {problems.length === 0 && (
                    <option value="">No problems available</option>
                  )}

                  {problems.map((problem) => (
                    <option key={problem.id} value={problem.id}>
                      {problem.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </section>

        {error && (
          <p className="leaderboard-error" role="alert">
            {error}
          </p>
        )}

        {loadingGroups && <p className="leaderboard-muted">Loading groups…</p>}

        {!loadingGroups && groups.length === 0 && (
          <p className="leaderboard-muted">
            You are not currently part of any groups.
          </p>
        )}

        {loadingLeaderboard && (
          <p className="leaderboard-muted">Loading leaderboard…</p>
        )}

        {!loadingLeaderboard &&
          viewType === 'problem' &&
          groupId &&
          !problemId && (
            <p className="leaderboard-muted">
              This group does not have any problems yet.
            </p>
          )}

        {/* Final leaderboard is only available after the event */}
        {!loadingLeaderboard && viewType === 'final' && !finalAvailable && (
          <p className="leaderboard-muted">
            The final leaderboard will be available once the event has ended.
          </p>
        )}

        {/* Final group leaderboard */}
        {!loadingLeaderboard && leaderboard && viewType === 'final' && (
          <FinalLeaderboard data={leaderboard} />
        )}

        {/* Leaderboard for one selected problem */}
        {!loadingLeaderboard && leaderboard && viewType === 'problem' && (
          <ProblemLeaderboard
            data={leaderboard}
            problem={problems.find(
              (problem) => String(problem.id) === String(problemId)
            )}
          />
        )}
      </div>
    </main>
  );
}

// Displays the final ranking for the selected group
function FinalLeaderboard({ data }) {
  return (
    <section className="leaderboard-panel">
      <div className="leaderboard-title-row">
        <div>
          <h2>{data.groupName}</h2>

          <p>
            Final leaderboard · Top {data.topK} problem
            {data.topK === 1 ? '' : 's'} counted
          </p>
        </div>
      </div>

      {data.leaderboard.length === 0 ? (
        <p className="leaderboard-muted">
          No teams have submitted solutions yet.
        </p>
      ) : (
        <div className="leaderboard-table-wrap">
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Team</th>
                <th>Final score</th>
              </tr>
            </thead>

            <tbody>
              {data.leaderboard.map((team) => (
                <tr key={team.teamId}>
                  <td>{team.position}</td>
                  <td>{team.teamName}</td>
                  <td>{formatScore(team.finalScore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Displays the ranking for one problem
function ProblemLeaderboard({ data, problem }) {
  return (
    <section className="leaderboard-panel">
      <div className="leaderboard-title-row">
        <div>
          <h2>{problem?.title || 'Problem leaderboard'}</h2>

          <p>
            {data.submittingTeams} submitting team
            {data.submittingTeams === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {data.leaderboard.length === 0 ? (
        <p className="leaderboard-muted">
          No teams have submitted a completed solution for this problem yet.
        </p>
      ) : (
        <div className="leaderboard-table-wrap">
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Team</th>
                <th>P</th>
                <th>T</th>
              </tr>
            </thead>

            <tbody>
              {data.leaderboard.map((team) => (
                <tr key={team.teamId}>
                  <td>{team.position}</td>
                  <td>{team.teamName}</td>
                  <td>{formatPercentage(team.P)}</td>
                  <td>{formatRuntime(team.T)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Checks whether the selected group's event has finished
function hasEventEnded(group) {
  if (!group?.startedAt) {
    return false;
  }

  if (group.status === 'ended') {
    return true;
  }

  if (group.endsAt) {
    return Date.now() >= new Date(group.endsAt).getTime();
  }

  if (Number.isFinite(group.durationMin)) {
    const endsAt =
      new Date(group.startedAt).getTime() + group.durationMin * 60 * 1000;

    return Date.now() >= endsAt;
  }

  return false;
}

// Keep final scores readable
function formatScore(score) {
  if (!Number.isFinite(score)) return '—';

  return Number(score.toFixed(4));
}

// P is stored as a percentage
function formatPercentage(score) {
  if (!Number.isFinite(score)) return '—';

  return `${Number(score.toFixed(2))}%`;
}

// Runtime is stored in milliseconds
function formatRuntime(runtime) {
  if (!Number.isFinite(runtime)) return '—';

  return `${Number(runtime.toFixed(2))} ms`;
}
