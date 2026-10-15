import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  clearSession,
  endSession,
  getToken,
  isIdleTooLong,
  markActivity,
} from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  // Why the user was signed out: 'idle', 'expired' or false
  const [expired, setExpired] = useState(false);

  const navigate = useNavigate();

  // Restore session. api() clears the token itself on a 401; any other
  // failure (e.g. the backend restarting) keeps it so a reload can recover.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api('/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Handle token expiration event
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setExpired((current) => current || 'expired');
      navigate('/login');
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [navigate]);

  // Signing out in another tab signs out this one too
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === 'token' && !event.newValue) {
        setUser(null);
        navigate('/login');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [navigate]);

  // Typing and clicking count as activity; editor traffic goes over the
  // WebSocket, so API calls alone would miss someone busy coding
  useEffect(() => {
    if (!user) return;
    window.addEventListener('keydown', markActivity);
    window.addEventListener('pointerdown', markActivity);
    return () => {
      window.removeEventListener('keydown', markActivity);
      window.removeEventListener('pointerdown', markActivity);
    };
  }, [user]);

  // Handle inactivity timeout (30 mins)
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (isIdleTooLong()) {
        endSession();
        setUser(null);
        setExpired('idle');
        navigate('/login');
      }
    }, 30 * 1000);
    return () => clearInterval(timer);
  }, [user, navigate]);

  // Login or Register
  const signIn = useCallback(
    async (mode, username, password) => {
      const data = await api(`/auth/${mode}`, {
        method: 'POST',
        body: { username, password },
      });
      clearSession();
      localStorage.setItem('token', data.token);
      markActivity();
      setExpired(false);
      setUser(data.user);
      navigate('/dashboard');
    },
    [navigate]
  );

  const signOut = useCallback(async () => {
    await endSession();
    setUser(null);
    navigate('/login');
  }, [navigate]);

  const value = useMemo(
    () => ({ user, loading, expired, signIn, signOut }),
    [user, loading, expired, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
