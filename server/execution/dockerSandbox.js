import { setTimeout, clearTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { chmod, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const IMAGE = 'python:3.12-slim';
// Every sandbox container carries this label so leftovers can be found
export const SANDBOX_LABEL = 'cs343-sandbox';
const DEFAULT_TIMEOUT_MS = 5000;
// Limit per stream (stdout and stderr are capped separately)
const MAX_OUTPUT_BYTES = 64 * 1024;
// Extra time the docker CLI gets on top of the in-container limit, to cover
// container start-up and attach overhead
const DOCKER_OVERHEAD_MS = 10000;
const DOCKER_COMMAND = 'docker';
// coreutils `timeout` exits with this code when it had to stop the program
const TIMEOUT_EXIT_CODE = 124;
// Unprivileged "nobody" user inside the container
const CONTAINER_USER = '65534:65534';
// How many sandbox containers may run at once (each is capped at half a CPU)
const MAX_CONCURRENT_RUNS =
  Number(process.env.SANDBOX_CONCURRENCY) ||
  Math.max(2, os.availableParallelism());

function dockerCommand(args, stdin = '', timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_COMMAND, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // Buffers are joined and decoded once at the end so multi-byte UTF-8
    // characters split across chunks are not corrupted
    const capture = (chunk, stream) => {
      const remaining = MAX_OUTPUT_BYTES - sizes[stream];
      if (chunk.length > remaining) {
        chunks[stream].push(chunk.subarray(0, remaining));
        sizes[stream] = MAX_OUTPUT_BYTES;
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      chunks[stream].push(chunk);
      sizes[stream] += chunk.length;
    };

    child.stdout.on('data', (chunk) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => capture(chunk, 'stderr'));

    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          stdout: Buffer.concat(chunks.stdout).toString('utf8'),
          stderr: Buffer.concat(chunks.stderr).toString('utf8'),
          exitCode,
          timedOut,
          outputExceeded,
        });
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

// Simple counting semaphore so a burst of runs can't exhaust the host
let activeRuns = 0;
const waitingRuns = [];

async function withRunSlot(task) {
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    await new Promise((resolve) => waitingRuns.push(resolve));
  } else {
    activeRuns += 1;
  }
  try {
    return await task();
  } finally {
    const next = waitingRuns.shift();
    // Hand the slot straight to the next waiter, or release it
    if (next) next();
    else activeRuns -= 1;
  }
}

// The container runs as an unprivileged user, so the mounted project must be
// readable by everyone (temporary directories are created as 0700)
async function makeWorldReadable(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeWorldReadable(entryPath);
    else await chmod(entryPath, 0o644);
  }
}

/**
 * Arguments shared by every sandbox container (after `docker create` or
 * `docker run`): no network, capped memory/CPU/processes, read-only file
 * system, no capabilities, an unprivileged user and the project mounted
 * read-only at /app. The program is stopped by `timeout` inside the
 * container, so container start-up time does not count against the limit.
 * scripts/docker-check.mjs uses the same arguments.
 */
export function sandboxArgs(projectDirectory, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return [
    '--label',
    SANDBOX_LABEL,
    '--network',
    'none',
    '--memory',
    '128m',
    '--memory-swap',
    '128m',
    '--cpus',
    '0.5',
    '--pids-limit',
    '64',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    CONTAINER_USER,
    '--mount',
    `type=bind,src=${projectDirectory},dst=/app,readonly`,
    '--workdir',
    '/app',
    IMAGE,
    'timeout',
    '-k',
    '1',
    String(timeoutMs / 1000),
    'python',
    '-B',
    '/app/main.py',
  ];
}

// Time the program itself ran, from Docker's own start/finish timestamps
// (nanosecond precision), or null if they are unavailable
async function containerRuntimeMs(containerName) {
  try {
    const inspect = await dockerCommand([
      'inspect',
      '--format',
      '{{.State.StartedAt}} {{.State.FinishedAt}}',
      containerName,
    ]);
    if (inspect.exitCode !== 0) return null;

    const [started, finished] = inspect.stdout.trim().split(' ').map(toMs);
    const runtime = finished - started;
    return Number.isFinite(runtime) && runtime >= 0 ? runtime : null;
  } catch {
    return null;
  }
}

// Parses an RFC 3339 timestamp, keeping sub-millisecond precision
function toMs(timestamp) {
  const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(
    timestamp ?? ''
  );
  if (!match) return NaN;
  const fraction = Number(`0.${match[2] ?? '0'}`);
  return Date.parse(`${match[1]}${match[3]}`) + fraction * 1000;
}

/**
 * Removes sandbox containers left behind when the server stopped mid-run
 * (for example a nodemon restart). Safe to call when Docker is not running.
 */
export async function removeOrphanedContainers() {
  try {
    const list = await dockerCommand([
      'ps',
      '--all',
      '--quiet',
      '--filter',
      `label=${SANDBOX_LABEL}`,
    ]);
    const ids = list.stdout.split(/\s+/).filter(Boolean);
    if (list.exitCode !== 0 || ids.length === 0) return 0;

    await dockerCommand(['rm', '--force', ...ids], '', 30000);
    return ids.length;
  } catch {
    return 0;
  }
}

/**
 * Execute main.py from a temporary project directory
 * inside a restricted Docker container.
 *
 * Requires a securely configured Docker daemon connection.
 */
export async function executeDockerPythonFile(
  filePath,
  stdin = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd
) {
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new Error('An absolute project directory is required.');
  }

  if (filePath !== 'main.py') {
    throw new Error('Only main.py is supported.');
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid timeout.');
  }

  return withRunSlot(() => runContainer(stdin, timeoutMs, cwd));
}

async function runContainer(stdin, timeoutMs, cwd) {
  const containerName = `cs343-${randomUUID()}`;
  await makeWorldReadable(cwd);

  try {
    const creation = await dockerCommand([
      'create',
      '--name',
      containerName,
      '--interactive',
      ...sandboxArgs(cwd, timeoutMs),
    ]);

    if (
      creation.exitCode !== 0 ||
      creation.timedOut ||
      creation.outputExceeded
    ) {
      throw new Error(`Docker creation failed: ${creation.stderr}`);
    }

    const started = performance.now();
    const execution = await dockerCommand(
      ['start', '--attach', '--interactive', containerName],
      stdin,
      timeoutMs + DOCKER_OVERHEAD_MS
    );
    const wallClockMs = performance.now() - started;

    const runtimeMs = (await containerRuntimeMs(containerName)) ?? wallClockMs;

    return {
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      // 137 = killed by `timeout -k` after ignoring the polite stop signal
      timedOut:
        execution.timedOut ||
        execution.exitCode === TIMEOUT_EXIT_CODE ||
        (execution.exitCode === 137 && runtimeMs >= timeoutMs),
      outputExceeded: execution.outputExceeded,
      runtimeMs,
    };
  } finally {
    // Always attempt to remove the container, including after timeout.
    try {
      const cleanup = await dockerCommand(
        ['rm', '--force', containerName],
        '',
        10000
      );

      if (cleanup.exitCode !== 0 || cleanup.timedOut) {
        console.error(
          `Docker cleanup failed for ${containerName}: ${cleanup.stderr}`
        );
      }
    } catch (cleanupError) {
      // Preserve the original execution error.
      console.error(
        `Docker cleanup could not run for ${containerName}:`,
        cleanupError
      );
    }
  }
}
