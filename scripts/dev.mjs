/**
 * Starts the dev servers. Usage: npm run dev -- [N] [--full]
 *
 *   npm run dev              backend on 5001 + client on 3000
 *   npm run dev -- 1         extra client on 3001 using the backend on 5001
 *                            (a second "user" in the same shared rooms)
 *   npm run dev -- 1 --full  extra client on 3001 with its own backend on 5002
 *                            (fully separate instance, rooms are not shared)
 */

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

const n = Number(
  args.find((a) => /^\d+$/.test(a)) ?? 0
);

const full =
  n === 0 || args.includes('--full');

//if you change these, keep those changes on your local machine
const BASE_SERVER_PORT = 5000;
const BASE_CLIENT_PORT = 3000;

const serverPort =
  BASE_SERVER_PORT + (full ? n : 0);

const clientPort =
  BASE_CLIENT_PORT + n;

const env = {
  ...process.env,
  PORT: String(serverPort),
  API_PORT: String(serverPort),
  CLIENT_PORT: String(clientPort),
};

const children = [];

const run = (name, prefix) => {
  const child = spawn(
    'npm',
    ['run', 'dev', '--prefix', prefix],
    {
      env,
      shell: true,
      stdio: 'inherit',
    }
  );

  child.on('exit', () => {
    children.forEach((c) => c.kill());
  });

  children.push(child);

  return child;
};

console.log(
  `Client: http://localhost:${clientPort}  Backend: http://localhost:${serverPort}${
    full ? '' : ' (shared)'
  }`
);

if (full) {
  run('server', 'server');
}

run('client', 'client');

process.on('SIGINT', () => {
  children.forEach((c) => c.kill());
});