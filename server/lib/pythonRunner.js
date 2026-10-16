import { executePython } from '../execution/pythonExecutor.js';

/**
 * Runs Python source from the shared editor (WebSocket RUN_CODE) in the
 * Docker sandbox and returns the fields the editor displays.
 *
 * Docker execution is disabled unless ENABLE_PYTHON_EXECUTION=true.
 */
export async function runPython(code, stdin = '') {
  const result = await executePython(code, stdin);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputExceeded,
  };
}
