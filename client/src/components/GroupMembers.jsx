import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useNotifications } from '../notifications/NotificationsContext.jsx';
import './GroupMembers.css';

// Who is in the group. The admin also gets the invite form and the list of
// people who have been invited but have not answered yet.
export default function GroupMembers({ group }) {
  const [data, setData] = useState(null); // { admin, members, invites }
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      setData(await api(`/groups/${group.id}/members`));
    } catch (err) {
      setError(err.message);
    }
  }

  // Reload when a live invite event arrives (e.g. someone accepted or declined)
  const { tick } = useNotifications();

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, tick]);

  // Invites close once the event starts, so teams can't change mid-event.
  const canInvite = group.isAdmin && group.status === 'not-started';

  async function handleInvite(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api(`/groups/${group.id}/invites`, {
        method: 'POST',
        body: { username: username.trim() },
      });
      setUsername('');
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelInvite(invite) {
    setError('');
    try {
      await api(`/groups/${group.id}/invites/${invite.id}`, {
        method: 'DELETE',
      });
      await reload();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="panel">
      <h2>Members</h2>

      {canInvite && (
        <form className="invite-form" onSubmit={handleInvite}>
          <label htmlFor="invite-username" className="sr-only">
            Username to invite
          </label>
          <input
            id="invite-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username to invite"
            autoComplete="off"
          />
          <button
            className="btn-primary"
            type="submit"
            disabled={busy || !username.trim()}
          >
            {busy ? 'Inviting…' : 'Invite'}
          </button>
        </form>
      )}
      {group.isAdmin && group.status !== 'not-started' && (
        <p className="form-hint">Invitations close once the event starts.</p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">Loading members…</p>}

      {data && (
        <ul className="member-list">
          <li>
            <span>{data.admin.username}</span>
            <span className="member-tag">Admin</span>
          </li>
          {data.members.map((m) => (
            <li key={m.id}>
              <span>{m.username}</span>
              <span className="member-tag">Member</span>
            </li>
          ))}
          {data.invites.map((invite) => (
            <li key={`invite-${invite.id}`} className="member-pending">
              <span>{invite.username}</span>
              <span className="member-tag">Invited</span>
              {canInvite && (
                <button
                  className="link-button"
                  onClick={() => cancelInvite(invite)}
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && data.members.length === 0 && data.invites.length === 0 && (
        <p className="form-hint">
          {group.isAdmin
            ? 'No members yet. Invite users by their username above.'
            : 'No other members yet.'}
        </p>
      )}
    </div>
  );
}
