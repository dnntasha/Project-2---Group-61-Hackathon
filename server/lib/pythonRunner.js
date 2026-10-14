import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeDockerPythonFile } from '../execution/dockerSandbox.js';

const EXECUTION_TIMEOUT_MS = 5000;
const MAX_CODE_BYTES = 256 * 1024;

/**
 * Runs Python source using the shared Docker executor.
 *
 * Docker execution is disabled by default until the
 * deployment environment has passed its security review.
 */
export async function runPython(code) {
  if (process.env.ENABLE_PYTHON_EXECUTION !== 'true') {
    throw new Error('Python execution is disabled.');
  }

  if (
    typeof code !== 'string' ||
    Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES
  ) {
    throw new Error('Invalid Python source code.');
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'code-editor-'));

  try {
    const scriptPath = path.join(directory, 'main.py');

    await writeFile(scriptPath, code, {
      encoding: 'utf8',
      mode: 0o600,
    });

    // The sandbox runs as the backend user's UID/GID.
    // Restrict directory access to that user.
    await chmod(directory, 0o700);

    const result = await executeDockerPythonFile(
      'main.py',
      '',
      EXECUTION_TIMEOUT_MS,
      directory
    );

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputExceeded,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
