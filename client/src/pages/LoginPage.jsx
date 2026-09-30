import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import './LoginPage.css';

export default function LoginPage() {
  const { signIn, expired } = useAuth();
  const [mode, setMode] = useState('login'); //userloginor register
  const [username, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isLogin = mode === 'login';

  //sets whether the user has picked to sign up or in
  function switchMode() {
    setMode(isLogin ? 'register' : 'login');
    setError('');
    setPassword('');
    setConfirm('');
  }

  async function handleSubmit(y) {
    y.preventDefault();
    setError('');

    if (!isLogin && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await signIn(mode, username.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-panel">
        <p className="auth-brand">The Hackathon</p>
        <h1>{isLogin ? 'Sign in' : 'Create an account'}</h1>
        <p className="auth-lead">
          {' '}
          {isLogin
            ? 'Sign in to see the groups, teams and problems.'
            : 'Create a username to join a group.'}
        </p>

        {expired && isLogin && (
          <p className="auth-notice" role="status">
            You have been inactive for 30 mins and have been signed out
          </p>
        )}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <label>
            Username
            <input
              value={username}
              onChange={(y) => setUserName(y.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(y) => setPassword(y.target.value)}
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              required
            />
            {!isLogin && (
              <span className="auth-hint">At least 8 characters</span>
            )}
          </label>

          {!isLogin && (
            <label>
              Confirm password
              <input
                type="password"
                value={confirm}
                onChange={(y) => setConfirm(y.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
          )}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button
            className="auth-submit"
            type="submit"
            disabled={busy || !username || !password}
          >
            {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="auth-switch">
          {isLogin ? 'New here?' : 'Do you already have an account?'}
          {''}
          <button type="button" onClick={switchMode}>
            {isLogin ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
    </main>
  );
}
