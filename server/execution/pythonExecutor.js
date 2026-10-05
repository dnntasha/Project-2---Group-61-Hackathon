import { spawn } from 'child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { performance } from 'node:perf_hooks';

const DEFAULT_TIMEOUT_MS = 5001;

/**
 * Executes Python source code directly using a child process.
 *
 * Used by the /api/execute route for normal code execution rather than
 * submission evaluation.
 *
 * Supports:
 * - stdin input
 * - stdout/stderr capture
 * - configurable execution timeout
 * - exit-code reporting
 * - execution runtime measurement
 *
 * A timed-out process is terminated with SIGKILL.
 */
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

/**
 * Executes a Python file from an existing codebase directory.
 *
 * This is used by the submission evaluator after the submitted file tree has
 * been reconstructed inside a temporary directory. The cwd parameter allows
 * imports between files in the submitted project to work normally.
 *
 * Returns the same execution metadata as executePython().
 */
export function executePythonFile(
  filePath,
  stdin = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd
) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();

    const pythonProcess = spawn('python3', [filePath], {
      cwd,
    });

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
