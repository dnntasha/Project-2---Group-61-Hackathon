import { useEffect, useState } from 'react';
import { api } from '../api.js';
import GroupIcon from '../components/GroupIcon.jsx';
import InviteList from '../components/InviteList.jsx';
import { useNotifications } from '../notifications/NotificationsContext.jsx';
import './Groups.css';

// Lists the user's groups and lets them create a new one.
export default function GroupsPage({ onOpen }) {
  const [groups, setGroups] = useState(null); // null = still loading
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { tick } = useNotifications(); // re-load when invites change live

  useEffect(() => {
    api('/groups')
      .then((data) => setGroups(data.groups))
      .catch((err) => setLoadError(err.message));
  }, [tick]);

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api('/groups', { method: 'POST', body: { name } });
      onOpen(data.group.id); // go straight to the new group
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section className="groups page-enter">
      <div className="group-container">
        <header className="groups-header">
          <h1>Your groups</h1>
          <p className="muted">
            Open a group to manage its teams, or start a new one.
          </p>
        </header>

        <InviteList onAccepted={onOpen} />

        <form className="panel group-create" onSubmit={handleCreate}>
          <h2>Create a group</h2>
          <p className="form-hint">
            You become the admin of groups you create.
          </p>

          <div className="group-create-row">
            <input
              id="group-name"
              aria-label="Group name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Stellenbosch Spring Hackathon"
              maxLength={40}
            />
            <button
              className="btn-primary"
              type="submit"
              disabled={busy || !name.trim()}
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>

        <div className="groups-list-section">
          <div className="groups-list-heading">
            <h2>Groups you&apos;re in</h2>
            {groups && <span className="member-count">{groups.length}</span>}
          </div>

          {loadError && <p className="form-error">{loadError}</p>}
          {!groups && !loadError && <p className="muted">Loading groups…</p>}
          {groups?.length === 0 && (
            <p className="form-hint">
              You are not in any groups yet. Create one, or wait for an invite.
            </p>
          )}

          {groups?.length > 0 && (
            <ul className="group-list">
              {groups.map((group) => (
                <li key={group.id}>
                  <button
                    className="group-card"
                    onClick={() => onOpen(group.id)}
                  >
                    <GroupIcon group={group} />
                    <span className="group-card-name">{group.name}</span>
                    {group.pendingInvites > 0 && (
                      <span
                        className="invite-dot"
                        role="img"
                        aria-label="Pending team invitation"
                      />
                    )}
                    <span className="member-badge">
                      {group.isAdmin ? 'Admin' : 'Member'}
                    </span>
                    {group.status === 'ended' ? (
                      <span className="group-card-meta">Ended</span>
                    ) : (
                      group.startedAt && (
                        <span className="group-card-meta">Started</span>
                      )
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
