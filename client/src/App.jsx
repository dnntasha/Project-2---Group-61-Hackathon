import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import LoginPage from './pages/LoginPage.jsx';

function Shell() {
  const { user, loading, signOut } = useAuth();

  if (loading) return <p style={{ margin: 'auto' }}> Get Readyy..</p>;
  if (!user) return <LoginPage />;

  //This is the rest of the app, what the signed in user will see
  return (
    <main style={{ padding: 24 }}>
      <p>
        Signed in as <strong>{user.username}</strong>{' '}
        <button onClick={signOut}>Sign Out</button>
      </p>
    </main>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
