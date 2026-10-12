import { NavLink, Link } from 'react-router-dom';
import './NavBar.css';

// Pages that don't exist yet point at /dashboard until they are built.
// Set `to` to the real route when the page is added.
const FALLBACK = '/dashboard';

const NAV_ITEMS = [
  { label: 'Home', to: '/home' },
  { label: 'Coding', to: '/coding' },
  { label: 'Groups', to: FALLBACK },
  { label: 'Leaderboard', to: FALLBACK },
  { label: 'Problems', to: FALLBACK },
];

export default function NavBar() {
  return (
    <nav className="navbar" aria-label="Main navigation">
      <ul className="navbar-list">
        {NAV_ITEMS.map(({ label, to }) => (
          <li key={label}>
            {to === FALLBACK ? (
              <Link to={to} className="navbar-link">
                {label}
              </Link>
            ) : (
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `navbar-link${isActive ? ' navbar-link--active' : ''}`
                }
              >
                {label}
              </NavLink>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
