import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EXECUTION_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export async function runPython(code) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'code-editor-'));
  const scriptPath = path.join(directory, 'main.py');

  try {
    await writeFile(scriptPath, code, 'utf8');

    const executable =
      process.env.PYTHON_EXECUTABLE ||
      (process.platform === 'win32' ? 'python' : 'python3');

    return await new Promise((resolve, reject) => {
      const child = spawn(executable, [scriptPath], {
        cwd: directory,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;
      let forceKillTimeout;

      const stopChild = () => {
        child.kill();
        forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 250);
      };

      const appendOutput = (chunk, getValue, setValue) => {
        if (settled || outputLimitExceeded) return;

        const text = chunk.toString('utf8');
        const availableBytes = MAX_OUTPUT_BYTES - outputBytes;
        const accepted = Buffer.from(text, 'utf8').subarray(0, availableBytes);
        setValue(getValue() + accepted.toString('utf8'));
        outputBytes += accepted.length;

        if (accepted.length < Buffer.byteLength(text, 'utf8')) {
          outputLimitExceeded = true;
          stopChild();
        }
      };

      child.stdout.on('data', (chunk) =>
        appendOutput(
          chunk,
          () => stdout,
          (value) => {
            stdout = value;
          }
        )
      );
      child.stderr.on('data', (chunk) =>
        appendOutput(
          chunk,
          () => stderr,
          (value) => {
            stderr = value;
          }
        )
      );

      const timeout = setTimeout(() => {
        timedOut = true;
        stopChild();
      }, EXECUTION_TIMEOUT_MS);

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKillTimeout);
        reject(error);
      });

      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKillTimeout);
        resolve({
          stdout,
          stderr,
          exitCode,
          timedOut,
          outputLimitExceeded,
        });
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
