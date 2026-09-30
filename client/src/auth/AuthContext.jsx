import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, isIdleTooLong, markActivity } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [expired, setExpired] = useState(false);

  //allows the users to restore the session if the token ins valid.
  useEffect(() => {
    if (!getToken()) return;
    api('/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => localStorage.removeItem('token'))
      .finally(() => setLoading(false));
  }, []);

  // An expired token signs the user out
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setExpired(true);
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  //user must be signed out if the have been inactive for 30 mins
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (isIdleTooLong()) {
        localStorage.removeItem('token');
        setUser(null);
        setExpired(true);
      }
    }, 30 * 1000);
    return () => clearInterval(timer);
  }, [user]);

  //either login ot register mode
  async function signIn(mode, username, password) {
    const data = await api(`/auth/${mode}`, {
      method: 'POST',
      body: { username, password },
    });
    localStorage.setItem('token', data.token);
    markActivity();
    setExpired(false);
    setUser(data.user);
  }

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('token');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, expired, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
