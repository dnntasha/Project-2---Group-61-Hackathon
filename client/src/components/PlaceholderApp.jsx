import FileTree from './FileTree/FileTree.jsx';
import LoginPage from '../pages/LoginPage';
import { AuthProvider, useAuth } from '../auth/AuthContext.jsx';
import './PlaceholderApp.css';

function App() {
  const { user, loading, signOut } = useAuth();

  if (loading) {
    return <p style={{ margin: 'auto' }}>Loading...</p>;
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <main className="app-shell page-enter">
      <header className="app-header">
        <p>
          You are signed in as <strong>{user.username}</strong>
        </p>

        <button type="button" className="app-signout" onClick={signOut}>
          Sign out
        </button>
      </header>

      {/* P4 file tree. File operations currently update local tree state.
          P3's WebSocket integration will synchronise these operations between
          team members using the stable file/directory node IDs. */}
      <FileTree />
    </main>
  );
}

export default function PlaceholderApp() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
