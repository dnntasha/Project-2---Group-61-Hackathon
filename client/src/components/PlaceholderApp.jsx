import { useState } from 'react';
import FileTree from './FileTree/FileTree.jsx';
import LoginPage from '../pages/LoginPage';
import GroupsPage from '../pages/GroupsPage.jsx';
import GroupPage from '../pages/GroupPage.jsx';
import { AuthProvider, useAuth } from '../auth/AuthContext.jsx';
//import './PlaceholderApp.css';

function App() {
  const { user, loading, signOut } = useAuth();

  const [groupId, setGroupId] = useState(null);

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

      <div className="app-content">
        {groupId ? (
          <GroupPage groupId={groupId} onBack={() => setGroupId(null)} />
        ) : (
          <GroupsPage onOpen={setGroupId} />
        )}
      </div>

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
