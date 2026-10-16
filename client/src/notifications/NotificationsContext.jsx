import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, getToken } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * Live invite notifications.
 *
 * While a user is signed in this provider keeps one WebSocket open to the
 * server (/ws/notifications). When anything about invites changes the server
 * sends a tiny `INVITES_CHANGED` message. We react in two ways:
 *  1. re-fetch the pending-invite count (shown as a badge in the navbar)
 *  2. bump `tick`, a counter other components list as an effect dependency, so
 *     their data-loading effects run again (see InviteList, GroupPage, ...)
 * Nothing sensitive travels over the socket; the real data is always fetched
 * through the normal authenticated REST API.
 */
const NotificationsContext = createContext({ pendingCount: 0, tick: 0 });

// Reconnect delays: start at 1s, double each failed attempt, cap at 15s
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;

// Same URL logic as the editor: ws(s)://<current host>/ws/notifications, with
// the session token as a query param (browsers can't set WebSocket headers)
function getNotificationsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${window.location.host}/ws/notifications`);
  url.searchParams.set('token', getToken() ?? '');
  return url.toString();
}

export function NotificationsProvider({ children }) {
  const { user } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const [tick, setTick] = useState(0);

  // Asks the server how many invites are waiting and stores the total
  const refreshCount = useCallback(async () => {
    try {
      const data = await api('/invites/count');
      setPendingCount(data.total);
    } catch {
      // Leave the old number in place; the next event or reconnect retries
    }
  }, []);

  // Open the socket when signed in, close it (via the cleanup) on sign-out
  useEffect(() => {
    if (!user) {
      setPendingCount(0);
      return undefined;
    }

    let socket = null;
    let retryTimer = null;
    let retryDelay = MIN_RETRY_MS;
    let stopped = false; // set by cleanup so we don't reconnect after unmount

    function connect() {
      socket = new WebSocket(getNotificationsUrl());

      socket.onopen = () => {
        retryDelay = MIN_RETRY_MS;
        // Events sent while we were disconnected were missed, so catch up
        refreshCount();
        setTick((t) => t + 1);
      };

      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'INVITES_CHANGED') {
          refreshCount();
          setTick((t) => t + 1);
        }
      };

      socket.onclose = (event) => {
        // 4001 = the server rejected our sign-in; reconnecting can't help
        if (stopped || event.code === 4001) return;
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      };
    }

    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [user, refreshCount]);

  // Memoised so consumers only re-render when a value actually changes
  const value = useMemo(
    () => ({ pendingCount, tick, refreshCount }),
    [pendingCount, tick, refreshCount]
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications() {
  return useContext(NotificationsContext);
}
