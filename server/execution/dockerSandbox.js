import { setTimeout, clearTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const IMAGE = 'python:3.12-slim';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DOCKER_COMMAND = 'docker';

function dockerCommand(args, stdin = '', timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_COMMAND, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const capture = (chunk, stream) => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
      const kept = chunk.subarray(0, remaining);

      outputBytes += kept.length;

      if (stream === 'stdout') stdout += kept.toString();
      else stderr += kept.toString();

      if (chunk.length > remaining || outputBytes >= MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill('SIGKILL');
      }
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
          stdout,
          stderr,
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

  const started = performance.now();
  const containerName = `cs343-${randomUUID()}`;
  // process.getuid does not exist on Windows. Docker Desktop maps bind mounts
  // to world-readable files there, so an unprivileged user (nobody) is enough.
  const containerUser =
    typeof process.getuid === 'function'
      ? `${process.getuid()}:${process.getgid()}`
      : '65534:65534';

  const createArgs = [
    'create',
    '--name',
    containerName,
    '--interactive',
    '--network',
    'none',
    '--memory',
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
    containerUser,
    '--mount',
    `type=bind,src=${cwd},dst=/app,readonly`,
    '--workdir',
    '/app',
    IMAGE,
    'python',
    '-B',
    '/app/main.py',
  ];

  try {
    const creation = await dockerCommand(createArgs);

    if (
      creation.exitCode !== 0 ||
      creation.timedOut ||
      creation.outputExceeded
    ) {
      throw new Error(`Docker creation failed: ${creation.stderr}`);
    }

    const execution = await dockerCommand(
      ['start', '--attach', '--interactive', containerName],
      stdin,
      timeoutMs
    );

    return {
      ...execution,
      runtimeMs: performance.now() - started,
      containerName,
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
