import { executePython } from '../execution/pythonExecutor.js';
import {
  NO_MAIN_EXIT_CODE,
  NO_MAIN_MARKER,
} from '../execution/dockerSandbox.js';

/**
 * Runs Python source from the shared editor (WebSocket RUN_CODE) in the
 * Docker sandbox and returns the fields the editor displays.
 *
 * Like grading, the sandbox calls main() for the user, so running the code
 * behaves the same as submitting it.
 *
 * Docker execution is disabled unless ENABLE_PYTHON_EXECUTION=true.
 */
export async function runPython(code, stdin = '') {
  const result = await executePython(code, stdin, undefined, {
    callMain: true,
  });

  // The harness reports a missing main() with a marker; show a readable message
  const noMain =
    result.exitCode === NO_MAIN_EXIT_CODE &&
    (result.stderr ?? '').includes(NO_MAIN_MARKER);

  return {
    stdout: result.stdout,
    stderr: noMain ? 'main() is not defined.' : result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputExceeded,
  };
}
