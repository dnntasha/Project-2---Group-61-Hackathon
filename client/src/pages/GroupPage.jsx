import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import GroupIcon from '../components/GroupIcon.jsx';
import Countdown from '../components/Countdown.jsx';
import ProblemsPanel from '../components/ProblemsPanel.jsx';
import GroupMembers from '../components/GroupMembers.jsx';
import { useNotifications } from '../notifications/NotificationsContext.jsx';
import { useNavigate } from '../router.jsx';
import './Groups.css';

const STATUS_TEXT = {
  'not-started': 'Not started yet',
  running: 'Event in progress',
  ended: 'Event ended',
};

const FIELDS = [
  {
    key: 'durationMin',
    label: 'Event duration',
    hint: 'How long the event runs once started, in minutes.',
    min: 10,
    max: 1440,
  },
  {
    key: 'maxTeamSize',
    label: 'Maximum team size',
    hint: 'The most members a team can have, including pending invites.',
    min: 1,
    max: 10,
  },
  {
    key: 'topK',
    label: 'Problems counted in score',
    hint: "Only a team's best results on this many problems count.",
    min: 1,
    max: 50,
  },
];

export default function GroupPage({ groupId, onBack }) {
  const [group, setGroup] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('members');
  //the signed in user's team to be highlited
  const { tick } = useNotifications();

  useEffect(() => {
    api(`/groups/${groupId}`)
      .then((data) => setGroup(data.group))
      .catch((err) => setLoadError(err.message));
  }, [groupId, tick]);

  // Settings, icon and start responses don't include the member list, so
  // merge them into the loaded group instead of replacing it
  const mergeGroup = useCallback((updated) => {
    setGroup((current) => ({ ...current, ...updated }));
  }, []);

  // Only the admin gets the problems and settings pages
  const started = group && group.status !== 'not-started';
  const tabs = [
    { key: 'members', label: 'Members & teams' },
    ...(group?.isAdmin || started
      ? [{ key: 'problems', label: 'Problems' }]
      : []),
    ...(group?.isAdmin ? [{ key: 'settings', label: 'Settings' }] : []),
  ];
  // const tabs = group?.isAdmin
  //   ? [
  //       { key: 'members', label: 'Members & teams' },
  //       { key: 'problems', label: 'Problems' },
  //       { key: 'settings', label: 'Settings' },
  //     ]
  //   : [{ key: 'members', label: 'Members & teams' }];

  const activeTab = tabs.some(({ key }) => key === tab) ? tab : 'members';

  return (
    <section className="groups page-enter">
      <button className="back-button" onClick={onBack}>
        ← All groups
      </button>

      {loadError && <p className="form-error">{loadError}</p>}
      {!group && !loadError && <p className="muted">Loading…</p>}

      {group && (
        <div className="group-container">
          <header className="group-heading">
            <GroupIcon group={group} size={56} />

            <div>
              <h1>{group.name}</h1>
              <p className="muted">
                {group.isAdmin ? 'You are the admin' : 'Member'} ·{' '}
                {STATUS_TEXT[group.status]}
              </p>
            </div>

            {group.isAdmin && group.status === 'not-started' && (
              <StartEvent group={group} onStarted={mergeGroup} />
            )}

            {group.status === 'running' && (
              <Countdown
                endsAt={group.endsAt}
                serverTime={group.serverTime}
                onEnd={() =>
                  setGroup((current) => ({
                    ...current,
                    status: 'ended',
                  }))
                }
              />
            )}
          </header>

          {tabs.length > 1 && (
            <div className="group-tabs" role="tablist">
              {tabs.map(({ key, label }) => (
                <button
                  key={key}
                  role="tab"
                  type="button"
                  aria-selected={activeTab === key}
                  className={`group-tab ${
                    activeTab === key ? 'group-tab-active' : ''
                  }`}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {activeTab === 'members' && (
            <>
              <GroupMembers group={group} />
              <TeamsPanel group={group} />
            </>
          )}

          {activeTab === 'problems' && <ProblemsPanel group={group} />}

          {activeTab === 'settings' && (
            <>
              <IconUpload group={group} onSaved={mergeGroup} />
              <SettingsForm group={group} onSaved={mergeGroup} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function StartEvent({ group, onStarted }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleStart() {
    const ok = window.confirm(
      `Start "${group.name}" now? Teams lock and problems are revealed, this cannot be undone.`
    );

    if (!ok) return;

    setError('');
    setBusy(true);

    try {
      const data = await api(`/groups/${group.id}/start`, {
        method: 'POST',
      });

      onStarted(data.group);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="start-event">
      <button className="btn-primary" onClick={handleStart} disabled={busy}>
        {busy ? 'Starting...' : 'Start event'}
      </button>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function TeamsPanel({ group }) {
  const [teamData, setTeamData] = useState(null);
  const [error, setError] = useState('');

  const loadTeams = useCallback(async () => {
    try {
      setError('');
      const data = await api(`/teams/group/${group.id}`);
      setTeamData(data);
    } catch (err) {
      setError(err.message);
    }
  }, [group.id]);

  // Reload the teams (and the user's pending team invites) whenever the server
  // pushes an invite change, so new team invites appear without a refresh
  const { tick } = useNotifications();

  useEffect(() => {
    loadTeams();
  }, [loadTeams, tick]);

  const locked = group.status !== 'not-started';

  return (
    <div className="panel teams-panel">
      <div className="teams-heading">
        <div>
          <h2>Teams</h2>
          <p className="form-hint">
            Create a team or manage your team for this event.
          </p>
        </div>

        {teamData && (
          <span className="member-count">{teamData.teams.length}</span>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {!teamData && !error && <p className="muted">Loading teams…</p>}

      {teamData && (
        <>
          <PendingTeamInvites
            invites={teamData.pendingInvites}
            locked={locked}
            onChanged={loadTeams}
          />

          {locked && teamData.currentTeamId && (
            <AssignedProblem
              team={teamData.teams.find((t) => t.id === teamData.currentTeamId)}
            />
          )}

          {!locked && !teamData.currentTeamId && (
            <CreateTeam group={group} onCreated={loadTeams} />
          )}

          {locked && !teamData.currentTeamId && (
            <p className="form-hint teams-locked-message">
              Team creation is closed because the event has started.
            </p>
          )}

          {teamData.teams.length === 0 ? (
            <p className="form-hint teams-empty">
              No teams have been created yet.
            </p>
          ) : (
            <div className="team-list">
              {teamData.teams.map((team) => (
                <TeamCard
                  key={team.id}
                  team={team}
                  group={group}
                  locked={locked}
                  maxTeamSize={teamData.maxTeamSize}
                  onChanged={loadTeams}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Problems are assigned to teams by a later feature; until then there is
// nothing to show
function AssignedProblem({ team }) {
  const navigate = useNavigate();
  const problem = team?.activeProblem;
  return (
    <div className="team-card team-card-current">
      <h3>Your team&apos;s problem</h3>
      <p className="form-hint">
        {problem
          ? `${problem.orderIndex + 1}. ${problem.title}`
          : 'No problem has been assigned to your team yet.'}{' '}
        {team?.isCurrentUserLeader
          ? 'As the leader you choose the problem in the code editor.'
          : 'Your team leader chooses the problem in the code editor'}
      </p>
      {team && (
        <div className="team-actions">
          <button
            className="btn-primary"
            type="button"
            onClick={() => navigate(`/coding?roomId=team-${team.id}`)}
          >
            Open code editor
          </button>
        </div>
      )}
    </div>
  );
}

function CreateTeam({ group, onCreated }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleCreate(e) {
    e.preventDefault();

    const trimmed = name.trim();

    if (!trimmed) return;

    setError('');
    setBusy(true);

    try {
      await api('/teams', {
        method: 'POST',
        body: {
          name: trimmed,
          groupId: group.id,
        },
      });

      setName('');
      await onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="team-create" onSubmit={handleCreate}>
      <label>
        Create a team
        <div className="team-create-row">
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
            placeholder="Enter team name"
            maxLength={40}
            required
          />

          <button
            className="btn-primary"
            type="submit"
            disabled={busy || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create team'}
          </button>
        </div>
      </label>

      <p className="form-hint">
        You become the team leader when you create a team.
      </p>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function PendingTeamInvites({ invites, locked, onChanged }) {
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  if (!invites?.length) {
    return null;
  }

  async function handleInvite(inviteId, action) {
    setError('');
    setBusyId(inviteId);

    try {
      await api(`/teams/invites/${inviteId}/${action}`, {
        method: 'POST',
      });

      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="team-invites">
      <h3>Team invitations</h3>

      <div className="team-invite-list">
        {invites.map((invite) => (
          <div className="team-invite-card" key={invite.id}>
            <div className="team-avatar">
              {invite.team.name.charAt(0).toUpperCase()}
            </div>

            <div className="team-invite-info">
              <strong>{invite.team.name}</strong>
              <span>Invited by {invite.team.leaderUsername}</span>
            </div>

            <div className="team-invite-actions">
              <button
                className="btn-secondary btn-small"
                type="button"
                disabled={busyId === invite.id}
                onClick={() => handleInvite(invite.id, 'decline')}
              >
                Decline
              </button>

              <button
                className="btn-primary btn-small"
                type="button"
                disabled={locked || busyId === invite.id}
                onClick={() => handleInvite(invite.id, 'accept')}
              >
                {locked ? 'Closed' : 'Accept'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function TeamCard({ team, group, locked, maxTeamSize, onChanged }) {
  const [inviteUserId, setInviteUserId] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState('');
  const [cancelBusyId, setCancelBusyId] = useState(null);

  // Pending invitations hold a place in the team just like members do, so the
  // team counts as full when members + invitations reach the maximum
  const placesUsed = team.members.length + team.inviteCount;
  const isFull = placesUsed >= maxTeamSize;

  // Group members who could still be invited: not on this team and not already
  // invited to it
  const eligibleMembers = (group.members || []).filter(
    (groupMember) =>
      !team.members.some((teamMember) => teamMember.id === groupMember.id) &&
      !team.invites.some((invite) => invite.userId === groupMember.id)
  );

  async function handleCancelInvite(inviteId) {
    setInviteError('');
    setInviteSuccess('');
    setCancelBusyId(inviteId);

    try {
      await api(`/teams/${team.id}/invites/${inviteId}`, {
        method: 'DELETE',
      });

      await onChanged();
    } catch (err) {
      setInviteError(err.message);
    } finally {
      setCancelBusyId(null);
    }
  }

  async function handleInvite(e) {
    e.preventDefault();

    const id = Number(inviteUserId);

    if (!Number.isInteger(id)) {
      setInviteError('Select a group member.');
      return;
    }

    setInviteError('');
    setInviteSuccess('');
    setInviteBusy(true);

    try {
      await api(`/teams/${team.id}/invites`, {
        method: 'POST',
        body: {
          userId: id,
        },
      });

      setInviteSuccess('Team invitation sent.');
      setInviteUserId('');

      await onChanged();
    } catch (err) {
      setInviteError(err.message);
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleLeave() {
    const ok = window.confirm(
      team.isCurrentUserLeader
        ? 'Leave this team? Leadership will pass to the longest-standing remaining member.'
        : 'Leave this team?'
    );

    if (!ok) return;

    setLeaveError('');
    setLeaveBusy(true);

    try {
      await api(`/teams/${team.id}/leave`, {
        method: 'POST',
      });

      await onChanged();
    } catch (err) {
      setLeaveError(err.message);
    } finally {
      setLeaveBusy(false);
    }
  }

  return (
    <div
      className={`team-card ${
        team.isCurrentUserMember ? 'team-card-current' : ''
      }`}
    >
      <div className="team-card-heading">
        <div className="team-avatar">{team.name.charAt(0).toUpperCase()}</div>

        <div className="team-card-title">
          <div className="team-name-row">
            <strong>{team.name}</strong>

            {team.isCurrentUserMember && (
              <span className="member-badge">Your team</span>
            )}
          </div>

          <span className="member-meta">
            {team.members.length}/{maxTeamSize} members
            {team.inviteCount > 0 && ` · ${team.inviteCount} invited`} · Leader:{' '}
            {team.leaderUsername}
          </span>
        </div>
      </div>

      <ul className="team-member-list">
        {team.members.map((member) => (
          <li className="team-member-row" key={member.id}>
            <div className="team-member-name">
              <div className="member-avatar member-avatar-small">
                {member.username.charAt(0).toUpperCase()}
              </div>

              <span>{member.username}</span>
            </div>

            {member.isLeader && <span className="member-badge">Leader</span>}
          </li>
        ))}
      </ul>

      {team.invites.length > 0 && (
        <ul className="team-member-list" aria-label="Pending invitations">
          {team.invites.map((invite) => (
            <li className="team-member-row" key={invite.id}>
              <div className="team-member-name">
                <div className="member-avatar member-avatar-small">
                  {invite.username.charAt(0).toUpperCase()}
                </div>

                <span>{invite.username}</span>
              </div>

              <span className="member-badge">Invited</span>

              {team.isCurrentUserLeader && !locked && (
                <button
                  className="btn-secondary btn-small"
                  type="button"
                  disabled={cancelBusyId === invite.id}
                  onClick={() => handleCancelInvite(invite.id)}
                >
                  {cancelBusyId === invite.id ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {team.isCurrentUserLeader && !locked && (
        <form className="team-member-invite" onSubmit={handleInvite}>
          <label>
            Invite a group member
            <div className="team-invite-row">
              <select
                value={inviteUserId}
                onChange={(e) => {
                  setInviteUserId(e.target.value);
                  setInviteError('');
                  setInviteSuccess('');
                }}
                disabled={inviteBusy || isFull}
                required
              >
                <option value="">Choose a member</option>

                {eligibleMembers.map((member) => (
                  <option value={member.id} key={member.id}>
                    {member.username}
                  </option>
                ))}
              </select>

              <button
                className="btn-primary btn-small"
                type="submit"
                disabled={inviteBusy || !inviteUserId || isFull}
              >
                {inviteBusy ? 'Sending…' : 'Invite'}
              </button>
            </div>
          </label>

          {isFull ? (
            <p className="form-hint">
              The team is full. Cancel an invitation to free a place.
            </p>
          ) : (
            eligibleMembers.length === 0 && (
              <p className="form-hint">No available group members to invite.</p>
            )
          )}

          {inviteError && (
            <p className="form-error" role="alert">
              {inviteError}
            </p>
          )}

          {inviteSuccess && <p className="form-saved">{inviteSuccess}</p>}
        </form>
      )}

      {team.isCurrentUserMember && !locked && (
        <div className="team-actions">
          <button
            className="btn-secondary"
            type="button"
            disabled={leaveBusy}
            onClick={handleLeave}
          >
            {leaveBusy ? 'Leaving…' : 'Leave team'}
          </button>
        </div>
      )}

      {team.isCurrentUserMember && locked && (
        <p className="form-hint team-locked">
          Team membership is locked for the event.
        </p>
      )}

      {leaveError && (
        <p className="form-error" role="alert">
          {leaveError}
        </p>
      )}
    </div>
  );
}

function IconUpload({ group, onSaved }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleFile(e) {
    const file = e.target.files[0];

    e.target.value = '';

    if (!file) return;

    setError('');
    setBusy(true);

    try {
      const form = new FormData();

      form.append('icon', file);

      const data = await api(`/groups/${group.id}/icon`, {
        method: 'POST',
        body: form,
      });

      onSaved(data.group);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Group icon</h2>

      <p className="form-hint">PNG, JPEG, GIF or WebP, up to 2 MB.</p>

      <label className="btn-secondary file-button">
        {busy ? 'Uploading…' : group.iconUrl ? 'Change icon' : 'Upload icon'}

        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={handleFile}
          disabled={busy}
        />
      </label>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SettingsForm({ group, onSaved }) {
  const locked = group.status !== 'not-started';

  const [values, setValues] = useState({
    durationMin: String(group.durationMin),
    maxTeamSize: String(group.maxTeamSize),
    topK: String(group.topK),
  });

  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  function update(key, value) {
    setValues((current) => ({
      ...current,
      [key]: value,
    }));

    setSaved(false);
  }

  async function handleSave(e) {
    e.preventDefault();

    setError('');
    setBusy(true);

    try {
      const body = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, Number(value)])
      );

      const data = await api(`/groups/${group.id}/settings`, {
        method: 'PATCH',
        body,
      });

      onSaved(data.group);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={handleSave}>
      <h2>Event settings</h2>

      {locked && (
        <p className="form-hint">Settings are locked once the event starts.</p>
      )}

      <div className="settings-list">
        {FIELDS.map(({ key, label, hint, min, max }) => (
          <label className="settings-row" key={key}>
            <span className="settings-row-text">
              <span className="settings-row-label">{label}</span>
              <span className="form-hint">{hint}</span>
            </span>

            <input
              type="number"
              min={min}
              max={max}
              step={1}
              value={values[key]}
              onChange={(e) => update(key, e.target.value)}
              disabled={locked}
              required
            />
          </label>
        ))}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {!locked && (
        <div className="form-actions">
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>

          {saved && <span className="form-saved">Saved</span>}
        </div>
      )}
    </form>
  );
}
