import { NavLink } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useNotifications } from '../../notifications/NotificationsContext.jsx';
import './NavBar.css';

// Problems and the leaderboard live on each group's page.
const NAV_ITEMS = [
  { label: 'Home', to: '/home' },
  { label: 'Groups', to: '/dashboard' },
  { label: 'Coding', to: '/coding' },
];

export default function NavBar() {
  const { user, signOut } = useAuth();
  // Number of group + team invitations waiting for this user. It updates live
  // because NotificationsProvider listens on a WebSocket.
  const { pendingCount } = useNotifications();

  return (
    <nav className="navbar" aria-label="Main navigation">
      <ul className="navbar-list">
        {NAV_ITEMS.map(({ label, to }) => (
          <li key={label}>
            <NavLink
              to={to}
              className={({ isActive }) =>
                `navbar-link${isActive ? ' navbar-link--active' : ''}`
              }
            >
              {label}
              {/* Invites are answered on the Groups page, so badge that link */}
              {to === '/dashboard' && pendingCount > 0 && (
                <span
                  className="navbar-badge"
                  aria-label={`${pendingCount} pending invitation${pendingCount === 1 ? '' : 's'}`}
                >
                  {pendingCount}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="navbar-user">
        <span>
          Signed in as <strong>{user?.username}</strong>
        </span>
        <button type="button" className="app-signout" onClick={signOut}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
