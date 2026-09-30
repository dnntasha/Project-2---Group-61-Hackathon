import { spawn } from 'child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { performance } from 'node:perf_hooks';

const DEFAULT_TIMEOUT_MS = 5000;

export function executePython(
  code,
  stdin = '',
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    const pythonProcess = spawn('python3', ['-c', code]);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      pythonProcess.kill('SIGKILL');
    }, timeoutMs);

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('error', (error) => {
      clearTimeout(timeout);

      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    pythonProcess.on('close', (exitCode) => {
      clearTimeout(timeout);

      const runtimeMs = performance.now() - startTime;

      if (!settled) {
        settled = true;

        resolve({
          stdout,
          stderr,
          exitCode,
          timedOut,
          runtimeMs,
        });
      }
    });

    if (stdin) {
      pythonProcess.stdin.write(stdin);
    }

    pythonProcess.stdin.end();
  });
}
