import { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken, isIdleTooLong, markActivity } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [expired, setExpired] = useState(false);

  // Call useNavigate at the top level of the component
  const navigate = useNavigate();

  // Restore session
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api('/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => localStorage.removeItem('token'))
      .finally(() => setLoading(false));
  }, []);

  // Handle token expiration event
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setExpired(true);
      navigate('/login');
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [navigate]);

  // Handle inactivity timeout (30 mins)
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (isIdleTooLong()) {
        localStorage.removeItem('token');
        setUser(null);
        setExpired(true);
        navigate('/login');
      }
    }, 30 * 1000);
    return () => clearInterval(timer);
  }, [user, navigate]);

  // Login or Register
  async function signIn(mode, username, password) {
    const data = await api(`/auth/${mode}`, {
      method: 'POST',
      body: { username, password },
    });
    localStorage.setItem('token', data.token);
    markActivity();
    setExpired(false);
    setUser(data.user);

    // Redirect to profile after successful sign-in
    navigate('/profile');
  }

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('token');
    setUser(null);
    navigate('/login');
  }

  return (
    <AuthContext.Provider value={{ user, loading, expired, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
