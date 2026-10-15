/**
 * Verifies the Docker sandbox used for Python execution.
 *
 *   node scripts/docker-check.mjs            verify only
 *   node scripts/docker-check.mjs --setup    also start the daemon and pull the image
 *
 * SKIP_DOCKER_CHECK=1 skips everything.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// Same image and container restrictions the server uses
import { IMAGE, sandboxArgs } from '../server/execution/dockerSandbox.js';

const setup = process.argv.includes('--setup');

if (process.env.SKIP_DOCKER_CHECK === '1') {
  console.log('[docker] SKIP_DOCKER_CHECK=1, skipping Docker check.');
  process.exit(0);
}

const docker = (args, opts = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', timeout: 300000, ...opts });

const fail = (msg) => {
  console.error(`[docker] ${msg}`);
  console.error('[docker] For frontend-only work set SKIP_DOCKER_CHECK=1.');
  process.exit(1);
};

const daemonUp = () => docker(['info'], { timeout: 20000 }).status === 0;

const version = docker(['--version'], { timeout: 10000 });
if (version.error || version.status !== 0) {
  fail(
    'Docker CLI not found. Install Docker Desktop, Rancher Desktop (dockerd) or Docker Engine.'
  );
}

if (!daemonUp()) {
  if (!setup) fail('Docker daemon is not running. Run `npm run docker:setup`.');

  console.log('[docker] Daemon not running, trying to start it...');
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    // Docker Desktop or Rancher Desktop, whichever is installed
    const exe = [
      path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'),
      path.join(programFiles, 'Rancher Desktop', 'Rancher Desktop.exe'),
      path.join(
        localAppData,
        'Programs',
        'Rancher Desktop',
        'Rancher Desktop.exe'
      ),
    ].find((candidate) => existsSync(candidate));
    if (!exe) {
      fail(
        'Docker Desktop / Rancher Desktop not found. Start Docker manually.'
      );
    }
    spawnSync('cmd', ['/c', 'start', '', exe], { stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    if (spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' }).status !== 0) {
      spawnSync('open', ['-a', 'Rancher Desktop'], { stdio: 'ignore' });
    }
  } else {
    spawnSync('systemctl', ['start', 'docker'], { stdio: 'inherit' });
  }

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !daemonUp()) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)']);
  }
  if (!daemonUp()) fail('Docker daemon did not start. Start it manually.');
}

if (docker(['image', 'inspect', IMAGE]).status !== 0) {
  if (!setup) fail(`Image ${IMAGE} is missing. Run \`npm run docker:setup\`.`);
  console.log(`[docker] Pulling ${IMAGE}...`);
  if (docker(['pull', IMAGE], { stdio: 'inherit' }).status !== 0) {
    fail(`Could not pull ${IMAGE}.`);
  }
}

// Run a test script through the same restrictions the server uses.
const dir = mkdtempSync(path.join(tmpdir(), 'cs343-check-'));
try {
  writeFileSync(path.join(dir, 'main.py'), 'print("sandbox-ok")\n');
  // The sandbox user is unprivileged, so the files must be world-readable
  chmodSync(dir, 0o755);
  chmodSync(path.join(dir, 'main.py'), 0o644);
  const run = docker(['run', '--rm', ...sandboxArgs(dir)]);
  if (run.status !== 0 || !run.stdout.includes('sandbox-ok')) {
    fail(`Sandbox test failed:\n${run.stderr || run.stdout}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('[docker] OK: daemon running, image present, sandbox works.');
