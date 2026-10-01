const IDLE_LIMIT_MS = 30 * 60 * 1000;
let lastActivity = Date.now();

export function markActivity() {
  lastActivity = Date.now();
}

export function isIdleTooLong() {
  return Date.now() - lastActivity > IDLE_LIMIT_MS;
}

export function getToken() {
  return localStorage.getItem('token');
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();

  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  markActivity();

  const data = await res.json().catch(() => ({}));

  // A 401 error when the sign in toek has expired
  if (res.status === 401 && token) {
    localStorage.removeItem('token');
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
