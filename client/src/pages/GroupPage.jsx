import { useEffect, useState } from 'react';
import { api } from '../api.js';
import GroupIcon from '../components/GroupIcon.jsx';
import Countdown from '../components/Countdown.jsx';
import './Groups.css';

const STATUS_TEXT = {
  'not-started': 'Not started yet',
  running: 'Event in progress',
  ended: 'Event ended',
};

const FIELDS = [
  {
    key: 'durationMin',
    label: 'Event duration (minutes)',
    min: 10,
    max: 1440,
  },
  {
    key: 'maxTeamSize',
    label: 'Maximum team size',
    min: 1,
    max: 10,
  },
  {
    key: 'topK',
    label: 'Problems counted in final score',
    min: 1,
    max: 50,
  },
];

export default function GroupPage({ groupId, onBack }) {
  const [group, setGroup] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api(`/groups/${groupId}`)
      .then((data) => setGroup(data.group))
      .catch((err) => setLoadError(err.message));
  }, [groupId]);

  return (
    <section className="groups page-enter">
      <button className="link-button" onClick={onBack}>
        ← All groups
      </button>

      {loadError && <p className="form-error">{loadError}</p>}

      {!group && !loadError && <p className="muted">Loading…</p>}

      {group && (
        <>
          <header className="group-heading">
            <GroupIcon group={group} size={56} />

            <div>
              <h1>{group.name}</h1>

              <p className="muted">
                {group.isAdmin ? 'You are the admin' : 'Member'} ·{' '}
                {STATUS_TEXT[group.status]}
              </p>
            </div>

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

          {group.isAdmin && group.status === 'not-started' && (
            <StartEvent group={group} onStarted={setGroup} />
          )}

          <MembersList group={group} />

          {group.isAdmin && <InviteUser group={group} />}

          {group.isAdmin ? (
            <>
              <IconUpload group={group} onSaved={setGroup} />

              <SettingsForm group={group} onSaved={setGroup} />
            </>
          ) : (
            <SettingsSummary group={group} />
          )}
        </>
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
    <div className="panel panel-start">
      <div>
        <h2>Start the event</h2>

        <p className="form-hint">
          Runs for {group.durationMin} minutes. Teams lock and problems become
          visible.
        </p>
      </div>

      <button className="btn-primary" onClick={handleStart} disabled={busy}>
        {busy ? 'Starting…' : 'Start event'}
      </button>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function MembersList({ group }) {
  const members = group.members || [];

  return (
    <div className="panel">
      <div className="members-heading">
        <div>
          <h2>Members</h2>

          <p className="form-hint">
            {members.length} {members.length === 1 ? 'member' : 'members'} in
            this group.
          </p>
        </div>

        <span className="member-count">{members.length}</span>
      </div>

      {members.length > 0 ? (
        <ul className="member-list">
          {members.map((member) => (
            <li key={member.id} className="member-row">
              <div className="member-avatar">
                {member.username?.charAt(0).toUpperCase()}
              </div>

              <div className="member-info">
                <span className="member-name">{member.username}</span>

                <span className="member-meta">User #{member.id}</span>
              </div>

              {member.isAdmin && <span className="member-badge">Admin</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="form-hint">No members yet.</p>
      )}
    </div>
  );
}

function InviteUser({ group }) {
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const locked = Boolean(group.startedAt);

  async function handleInvite(e) {
    e.preventDefault();

    setError('');
    setSuccess('');

    const id = Number(userId);

    if (!Number.isInteger(id) || id < 1) {
      setError('Enter a valid user ID.');
      return;
    }

    setBusy(true);

    try {
      await api(`/groups/${group.id}/invites`, {
        method: 'POST',

        body: {
          userId: id,
        },
      });

      setSuccess('Invitation sent.');
      setUserId('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel invite-panel" onSubmit={handleInvite}>
      <div>
        <h2>Invite a member</h2>

        <p className="form-hint">Invite another user to join this group.</p>
      </div>

      {locked ? (
        <p className="form-hint">
          Invitations are closed because the event has started.
        </p>
      ) : (
        <>
          <div className="invite-row">
            <label>
              User ID
              <input
                type="number"
                min="1"
                step="1"
                value={userId}
                onChange={(e) => {
                  setUserId(e.target.value);
                  setError('');
                  setSuccess('');
                }}
                placeholder="Enter user ID"
                required
              />
            </label>

            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send invite'}
            </button>
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          {success && (
            <p className="form-saved" role="status">
              {success}
            </p>
          )}
        </>
      )}
    </form>
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
  const locked = Boolean(group.startedAt);

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

      <div className="settings-grid">
        {FIELDS.map(({ key, label, min, max }) => (
          <label key={key}>
            {label}

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

function SettingsSummary({ group }) {
  return (
    <div className="panel">
      <h2>Event settings</h2>

      <dl className="settings-summary">
        {FIELDS.map(({ key, label }) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{group[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
