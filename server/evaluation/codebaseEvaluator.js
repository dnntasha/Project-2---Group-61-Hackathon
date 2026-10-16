import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  executeDockerPythonFile,
  NO_MAIN_EXIT_CODE,
  NO_MAIN_MARKER,
} from '../execution/dockerSandbox.js';

const MAIN_MISSING_REASON = 'main.py is missing.';
const MAIN_UNDEFINED_REASON = 'main() is not defined.';

/**
 * Validates a submitted file/directory name before writing it to disk.
 * This prevents invalid names and path traversal outside the temporary
 * submission directory.
 */
function validateNodeName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    path.isAbsolute(name)
  ) {
    throw new Error(`Invalid file or directory name: ${name}`);
  }
}

// Upper bounds for a submitted tree, matching the editor's room limits
const MAX_TREE_FILES = 200;
const MAX_TREE_DEPTH = 20;
const MAX_TOTAL_CONTENT_BYTES = 512 * 1024;

/**
 * Checks a submitted codebase tree without touching the disk. Returns an
 * error message, or null when the tree can be written and run.
 */
export function validateCodebaseTree(codebase) {
  if (
    !codebase ||
    codebase.type !== 'directory' ||
    !Array.isArray(codebase.children)
  ) {
    return 'A valid codebase directory is required.';
  }

  let files = 0;
  let bytes = 0;

  function check(children, depth) {
    if (depth > MAX_TREE_DEPTH) return 'The codebase is nested too deeply.';

    const names = new Set();
    for (const node of children) {
      try {
        validateNodeName(node?.name);
      } catch (error) {
        return error.message;
      }
      // Names are compared case-insensitively since Windows file systems are
      if (names.has(node.name.toLowerCase())) {
        return `Duplicate name in the same folder: ${node.name}`;
      }
      names.add(node.name.toLowerCase());

      if (node.type === 'directory') {
        if (!Array.isArray(node.children ?? [])) {
          return `Invalid directory: ${node.name}`;
        }
        const error = check(node.children ?? [], depth + 1);
        if (error) return error;
      } else if (node.type === 'file') {
        if (node.content !== undefined && typeof node.content !== 'string') {
          return `File content must be text: ${node.name}`;
        }
        files += 1;
        bytes += Buffer.byteLength(node.content ?? '', 'utf8');
      } else {
        return `Invalid node type: ${node.type}`;
      }
    }

    if (files > MAX_TREE_FILES) return 'The codebase has too many files.';
    if (bytes > MAX_TOTAL_CONTENT_BYTES) return 'The codebase is too large.';
    return null;
  }

  return check(codebase.children, 0);
}

/**
 * Recursively rebuilds one file-tree node inside the temporary submission
 * directory. Directory children are reconstructed recursively while file
 * nodes have their stored content written to disk.
 */
async function writeNode(node, parentPath) {
  validateNodeName(node.name);

  const nodePath = path.join(parentPath, node.name);

  if (node.type === 'directory') {
    await mkdir(nodePath, { recursive: true });

    for (const child of node.children ?? []) {
      await writeNode(child, nodePath);
    }

    return;
  }

  if (node.type === 'file') {
    await writeFile(nodePath, node.content ?? '', 'utf8');
    return;
  }

  throw new Error(`Invalid node type: ${node.type}`);
}

/**
 * Reconstructs the submitted project file tree inside an isolated temporary
 * directory. The directory is removed immediately if reconstruction fails.
 */
export async function createTemporaryCodebase(codebase) {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'cs343-submission-')
  );

  try {
    for (const node of codebase.children ?? []) {
      await writeNode(node, temporaryDirectory);
    }

    return temporaryDirectory;
  } catch (error) {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });

    throw error;
  }
}

/**
 * Checks that the submission contains a main.py file before running any tests.
 * Whether main() is defined is decided when the code runs: the sandbox harness
 * loads main.py and reports a missing entry point itself, which avoids guessing
 * from the source text.
 */
export async function validatePythonEntryPoint(temporaryDirectory) {
  try {
    const main = await stat(path.join(temporaryDirectory, 'main.py'));
    if (main.isFile()) {
      return { valid: true, reason: null };
    }
  } catch {
    // Fall through: no main.py
  }

  return { valid: false, reason: MAIN_MISSING_REASON };
}

/**
 * Output is compared ignoring Windows line endings and trailing whitespace
 * on each line, which test authors and programs often disagree on.
 */
export function normaliseOutput(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
}

/**
 * Executes main.py for one test case using the test input and time limit.
 *
 * A test fails when execution times out, Python exits with an error, or the
 * produced output does not match the expected output.
 */
export async function evaluateTestCase(temporaryDirectory, testCase) {
  const {
    input = '',
    expectedOutput = '',
    timeLimit = 5000,
    hidden = false,
  } = testCase;

  const execution = await executeDockerPythonFile(
    'main.py',
    input,
    timeLimit,
    temporaryDirectory,
    { callMain: true }
  );

  const actualOutput = normaliseOutput(execution.stdout);
  const expected = normaliseOutput(expectedOutput);

  let reason = null;

  if (execution.timedOut) {
    reason = 'Time limit exceeded.';
  } else if (execution.outputExceeded) {
    reason = 'Output limit exceeded.';
  } else if (
    execution.exitCode === NO_MAIN_EXIT_CODE &&
    execution.stderr.includes(NO_MAIN_MARKER)
  ) {
    reason = MAIN_UNDEFINED_REASON;
  } else if (execution.exitCode !== 0) {
    reason = 'Runtime error.';
  } else if (actualOutput !== expected) {
    reason = 'Incorrect output.';
  }

  return {
    passed: reason === null,
    hidden,
    stdout: execution.stdout,
    stderr: execution.stderr,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    runtimeMs: execution.runtimeMs,
    reason,
  };
}

/**
 * Converts the raw execution result into data that is safe to return to the
 * client. Hidden tests intentionally exclude their input and expected/actual
 * output when they fail.
 */
export function formatTestResult(testCase, result) {
  const formattedResult = {
    passed: result.passed,
    hidden: testCase.hidden ?? false,
    runtimeMs: result.runtimeMs,
    reason: result.reason,
  };

  if (result.passed) {
    return formattedResult;
  }

  if (testCase.hidden) {
    return formattedResult;
  }

  formattedResult.input = testCase.input ?? '';

  if (result.reason === 'Incorrect output.') {
    formattedResult.expectedOutput = testCase.expectedOutput ?? '';
    formattedResult.actualOutput = result.stdout;
  }

  return formattedResult;
}

/**
 * The failed result of a test case that could not run because the submission
 * has no usable entry point (it counts as a failure with no runtime).
 */
function entryPointFailure(testCase, { reason }) {
  return formatTestResult(testCase, {
    passed: false,
    runtimeMs: 0,
    reason,
    stdout: '',
  });
}

/**
 * Builds the evaluation report from the per-test results. `reason` is the
 * submission-wide failure (such as a missing main.py); without one, a generic
 * message is used when any test failed.
 */
function summariseResults(testCases, results, reason = null) {
  const passedTests = results.filter((result) => result.passed).length;

  const passPercentage =
    testCases.length === 0 ? 0 : (passedTests / testCases.length) * 100;

  const totalPassedRuntimeMs = results
    .filter((result) => result.passed)
    .reduce((total, result) => total + result.runtimeMs, 0);

  const allPassed = passedTests === testCases.length && reason === null;

  return {
    passed: allPassed,
    reason: allPassed ? null : (reason ?? 'One or more test cases failed.'),
    passedTests,
    totalTests: testCases.length,
    passPercentage,
    totalPassedRuntimeMs,
    results,
  };
}

/**
 * Evaluates a complete submission.
 *
 * Flow:
 * 1. Reconstruct the submitted file tree in a temporary directory.
 * 2. Validate main.py; main() is called by the sandbox, which reports it
 *    missing if it is not defined.
 * 3. Execute each test case.
 * 4. Protect hidden-test information.
 * 5. Calculate the percentage of tests passed (P).
 * 6. Calculate total runtime of passed tests (T).
 * 7. Remove the temporary codebase.
 *
 * The returned P and T values are consumed by the submission service and can
 * be passed to the leaderboard/ranking implementation.
 */
export async function evaluateCodebase(codebase, testCases = []) {
  let temporaryDirectory;

  try {
    temporaryDirectory = await createTemporaryCodebase(codebase);

    const entryPoint = await validatePythonEntryPoint(temporaryDirectory);

    // Every test case fails when there is no entry point, so each one still
    // gets its own result (hidden tests redacted like any other failure)
    if (!entryPoint.valid) {
      return summariseResults(
        testCases,
        testCases.map((testCase) => entryPointFailure(testCase, entryPoint)),
        entryPoint.reason
      );
    }

    const results = [];
    let entryFailure = null;

    for (const testCase of testCases) {
      // A missing main() fails the same way for every test case, so the
      // remaining tests are not run
      if (entryFailure) {
        results.push(entryPointFailure(testCase, entryFailure));
        continue;
      }

      const result = await evaluateTestCase(temporaryDirectory, testCase);

      if (result.reason === MAIN_UNDEFINED_REASON) {
        entryFailure = { reason: result.reason };
      }

      results.push(formatTestResult(testCase, result));
    }

    return summariseResults(
      testCases,
      results,
      entryFailure ? entryFailure.reason : null
    );
  } finally {
    if (temporaryDirectory) {
      await removeTemporaryCodebase(temporaryDirectory);
    }
  }
}

/**
 * Removes all temporary files created while evaluating a submission.
 */
export async function removeTemporaryCodebase(temporaryDirectory) {
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
  });
}
