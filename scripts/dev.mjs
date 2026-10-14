/**
 * Starts the dev servers. Usage: npm run dev -- [N] [--full]
 *
 *   npm run dev              backend on 5000 + client on 3000
 *   npm run dev -- 1         extra client on 3001 using the backend on 5000
 *                            (a second "user" in the same shared rooms)
 *   npm run dev -- 1 --full  extra client on 3001 with its own backend on 5001
 *                            (fully separate instance, rooms are not shared)
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 0);
const full = n === 0 || args.includes('--full');

const serverPort = 5000 + (full ? n : 0);
const clientPort = 3000 + n;
const env = {
  ...process.env,
  PORT: String(serverPort),
  API_PORT: String(serverPort),
  CLIENT_PORT: String(clientPort),
};

const children = [];
const run = (name, prefix) => {
  const child = spawn('npm', ['run', 'dev', '--prefix', prefix], {
    env,
    shell: true,
    stdio: 'inherit',
  });
  child.on('exit', () => children.forEach((c) => c.kill()));
  children.push(child);
  return child;
};

console.log(
  `Client: http://localhost:${clientPort}  Backend: http://localhost:${serverPort}${full ? '' : ' (shared)'}`
);
if (full) run('server', 'server');
run('client', 'client');
process.on('SIGINT', () => children.forEach((c) => c.kill()));
