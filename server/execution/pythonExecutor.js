import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeDockerPythonFile } from './dockerSandbox.js';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * Execute Python source code inside the Docker sandbox.
 * Execution is disabled by default.
 */
export async function executePython(
  code,
  stdin = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options = {}
) {
  if (process.env.ENABLE_PYTHON_EXECUTION !== 'true') {
    throw new Error('Python execution is disabled.');
  }

  if (
    typeof code !== 'string' ||
    Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES
  ) {
    throw new Error('Invalid Python source code.');
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'cs343-execute-'));

  try {
    await writeFile(path.join(directory, 'main.py'), code, {
      encoding: 'utf8',
      mode: 0o600,
    });

    return await executePythonFile(
      'main.py',
      stdin,
      timeoutMs,
      directory,
      options
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Execute a Python file from an existing project directory.
 */
export async function executePythonFile(
  filePath,
  stdin = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
  options = {}
) {
  if (process.env.ENABLE_PYTHON_EXECUTION !== 'true') {
    throw new Error('Python execution is disabled.');
  }

  if (
    typeof stdin !== 'string' ||
    Buffer.byteLength(stdin, 'utf8') > MAX_STDIN_BYTES
  ) {
    throw new Error('Invalid Python input.');
  }

  return executeDockerPythonFile(filePath, stdin, timeoutMs, cwd, options);
}
