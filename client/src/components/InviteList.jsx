import { useEffect, useState } from 'react';
import { api } from '../api.js';
import GroupIcon from './GroupIcon.jsx';
import { useNotifications } from '../notifications/NotificationsContext.jsx';
import './GroupMembers.css';

// The signed-in user's pending group invitations, with Accept and Decline.
// Renders nothing when there are none, so the page stays clean.
export default function InviteList({ onAccepted }) {
  const [invites, setInvites] = useState([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  // `tick` changes whenever the server pushes an invite change, so listing it
  // as a dependency re-runs this fetch and the list updates without a refresh
  const { tick } = useNotifications();

  useEffect(() => {
    api('/groups/invites/mine')
      .then((data) => setInvites(data.invites))
      .catch((err) => setError(err.message));
  }, [tick]);

  async function answer(invite, action) {
    setError('');
    setBusyId(invite.id);
    try {
      await api(`/groups/invites/${invite.id}/${action}`, { method: 'POST' });
      setInvites((list) => list.filter((i) => i.id !== invite.id));
      if (action === 'accept') onAccepted(invite.group.id); // open the group
    } catch (err) {
      // e.g. the event has already started
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (invites.length === 0 && !error) return null;

  return (
    <div className="panel invite-panel">
      <h2>Invitations</h2>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ul className="invite-list">
        {invites.map((invite) => (
          <li key={invite.id} className="invite-row">
            <GroupIcon group={invite.group} size={32} />
            <span className="invite-name">{invite.group.name}</span>
            <button
              className="btn-primary"
              onClick={() => answer(invite, 'accept')}
              disabled={busyId === invite.id}
            >
              Accept
            </button>
            <button
              className="btn-secondary"
              onClick={() => answer(invite, 'decline')}
              disabled={busyId === invite.id}
            >
              Decline
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
