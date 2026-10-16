/**
 * Starts the dev servers. Usage: npm run dev -- [N] [--full]
 *
 *   npm run dev              backend on 5000 + client on 3000
 *   npm run dev -- 1         extra client on 3001 using the backend on 5000
 *                            (a second "user" in the same shared rooms;
 *                            needs `npm run dev` running in another terminal)
 *   npm run dev -- 1 --full  extra client on 3001 with its own backend on 5001
 *                            (fully separate instance, rooms are not shared)
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);

const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 0);

const full = n === 0 || args.includes('--full');

//if you change these, keep those changes on your local machine
const BASE_SERVER_PORT = 5000;
const BASE_CLIENT_PORT = 3000;

const serverPort = BASE_SERVER_PORT + (full ? n : 0);

const clientPort = BASE_CLIENT_PORT + n;

const env = {
  ...process.env,
  PORT: String(serverPort),
  API_PORT: String(serverPort),
  CLIENT_PORT: String(clientPort),
};

// The backend runs Python in Docker: make sure the daemon is up and the image
// is pulled before starting. SKIP_DOCKER_CHECK=1 skips this (frontend-only work).
if (full) {
  const check = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./docker-check.mjs', import.meta.url)), '--setup'],
    { stdio: 'inherit' }
  );
  if (check.status !== 0) process.exit(check.status ?? 1);
}

const children = [];
let stopping = false;

// Stops a child and everything it started. On Windows killing the direct
// child would leave npm/nodemon/vite running and holding the ports.
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGTERM');
  }
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach(stop);
  process.exit(code);
}

const run = (prefix) => {
  // Run npm through node when started via `npm run` (no shell needed);
  // fall back to the shell's npm when this script is run directly
  const npmCli = process.env.npm_execpath;
  const child = npmCli
    ? spawn(process.execPath, [npmCli, 'run', 'dev', '--prefix', prefix], {
        env,
        stdio: 'inherit',
      })
    : spawn(`npm run dev --prefix ${prefix}`, {
        env,
        shell: true,
        stdio: 'inherit',
      });

  // If one server dies, stop the rest instead of leaving half the app up
  child.on('exit', (code) => stopAll(code ?? 0));

  children.push(child);

  return child;
};

console.log(
  `Client: http://localhost:${clientPort}  Backend: http://localhost:${serverPort}${
    full ? '' : ' (shared)'
  }`
);

if (full) {
  run('server');
}

run('client');

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
