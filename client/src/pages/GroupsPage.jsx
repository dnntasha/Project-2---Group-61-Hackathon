import { useEffect, useState } from 'react';
import { api } from '../api.js';
import GroupIcon from '../components/GroupIcon.jsx';
import './Groups.css';

// Lists the user's groups and lets them create a new one.
export default function GroupsPage({ onOpen }) {
  const [groups, setGroups] = useState(null); // null = still loading
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/groups')
      .then((data) => setGroups(data.groups))
      .catch((err) => setLoadError(err.message));
  }, []);

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
      <h1>Your groups</h1>

      <form className="group-create" onSubmit={handleCreate}>
        <label htmlFor="group-name">Create a group</label>
        <div className="group-create-row">
          <input
            id="group-name"
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
        <p className="form-hint">You become the admin of groups you create.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>

      {loadError && <p className="form-error">{loadError}</p>}
      {!groups && !loadError && <p className="muted">Loading groups…</p>}
      {groups?.length === 0 && (
        <p className="muted">
          You are not in any groups yet. Create one, or wait for an invite.
        </p>
      )}

      {groups?.length > 0 && (
        <ul className="group-list">
          {groups.map((group) => (
            <li key={group.id}>
              <button className="group-card" onClick={() => onOpen(group.id)}>
                <GroupIcon group={group} />
                <span className="group-card-name">{group.name}</span>
                <span className="group-card-meta">
                  {group.isAdmin ? 'Admin' : 'Member'}
                  {group.startedAt ? ' · Started' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
