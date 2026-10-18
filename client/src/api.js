const IDLE_LIMIT_MS = 30 * 60 * 1000;
// Activity is shared through localStorage so an idle tab doesn't sign out a
// tab the user is working in. Writes are throttled since keystrokes count.
const ACTIVITY_KEY = 'lastActivity';
const ACTIVITY_WRITE_INTERVAL_MS = 5000;
let lastActivityWrite = 0;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function markActivity() {
  const now = Date.now();
  if (now - lastActivityWrite < ACTIVITY_WRITE_INTERVAL_MS) return;
  lastActivityWrite = now;
  try {
    localStorage.setItem(ACTIVITY_KEY, String(now));
  } catch {
    // Storage unavailable: idle tracking falls back to "always active"
  }
}

export function isIdleTooLong() {
  const lastActivity = Number(readStorage(ACTIVITY_KEY));
  return Boolean(lastActivity) && Date.now() - lastActivity > IDLE_LIMIT_MS;
}

export function getToken() {
  return readStorage('token');
}

export function clearSession() {
  lastActivityWrite = 0;
  try {
    localStorage.removeItem('token');
    localStorage.removeItem(ACTIVITY_KEY);
  } catch {
    // Nothing to clear
  }
}

// Ends the session on the server (best effort) and forgets it locally.
// Uses fetch directly so a 401 here doesn't trigger the "expired" flow.
export async function endSession() {
  const token = getToken();
  clearSession();
  if (!token) return;
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    keepalive: true,
  }).catch(() => {});
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const isUpload = body instanceof FormData;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(!isUpload && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: isUpload ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach the server. Is the backend running?');
  }
  markActivity();

  const data = await res.json().catch(() => ({}));

  // A 401 means the sign-in token has expired or was revoked
  if (res.status === 401 && token) {
    clearSession();
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
