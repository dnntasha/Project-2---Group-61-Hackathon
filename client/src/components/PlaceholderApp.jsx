//import { useState } from 'react';
//import heroImg from '../assets/hero.png';
//import reactLogo from '../assets/react.svg';
//import viteLogo from '../assets/vite.svg';
import LoginPage from '../pages/LoginPage';
import { AuthProvider, useAuth } from '../auth/AuthContext.jsx';
import './PlaceholderApp.css';
//import { Routes, Route, Link } from 'react-router-dom';

function App() {
  //const [count, setCount] = useState(0);
  const { user, loading, signOut } = useAuth();
  if (loading) return <p style={{ margin: 'auto' }}> Loading... </p>;
  if (!user) return <LoginPage />;

  return (
    <main className="app-shell page-enter">
      <header className="app-header">
        <p>
          You are signed in as <strong>{user.username}</strong>{' '}
        </p>
        <button className="app-signout" onClick={signOut}>
          Sign out
        </button>
      </header>
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
