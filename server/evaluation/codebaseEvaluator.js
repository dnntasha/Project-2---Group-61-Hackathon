import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeDockerPythonFile } from '../execution/dockerSandbox.js';

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
 * Checks the required Python entry point before running any tests.
 * A valid submission must contain main.py and define a main() function.
 */
export async function validatePythonEntryPoint(temporaryDirectory) {
  const mainPath = path.join(temporaryDirectory, 'main.py');

  try {
    await access(mainPath);
  } catch {
    return {
      valid: false,
      reason: 'main.py is missing.',
    };
  }

  const mainContent = await readFile(mainPath, 'utf8');

  const mainFunctionPattern = /^\s*def\s+main\s*\(/m;

  if (!mainFunctionPattern.test(mainContent)) {
    return {
      valid: false,
      reason: 'main.py must define a main() function.',
    };
  }

  return {
    valid: true,
    reason: null,
  };
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
    temporaryDirectory
  );

  const actualOutput = normaliseOutput(execution.stdout);
  const expected = normaliseOutput(expectedOutput);

  let reason = null;

  if (execution.timedOut) {
    reason = 'Time limit exceeded.';
  } else if (execution.outputExceeded) {
    reason = 'Output limit exceeded.';
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
 * Evaluates a complete submission.
 *
 * Flow:
 * 1. Reconstruct the submitted file tree in a temporary directory.
 * 2. Validate main.py and main().
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

    if (!entryPoint.valid) {
      return {
        passed: false,
        reason: entryPoint.reason,
        passedTests: 0,
        totalTests: testCases.length,
        passPercentage: 0,
        totalPassedRuntimeMs: 0,
        results: [],
      };
    }

    const results = [];

    for (const testCase of testCases) {
      const result = await evaluateTestCase(temporaryDirectory, testCase);

      results.push(formatTestResult(testCase, result));
    }

    const passedTests = results.filter((result) => result.passed).length;

    const passPercentage =
      testCases.length === 0 ? 0 : (passedTests / testCases.length) * 100;

    const totalPassedRuntimeMs = results
      .filter((result) => result.passed)
      .reduce((total, result) => total + result.runtimeMs, 0);

    return {
      passed: passedTests === testCases.length,
      reason:
        passedTests === testCases.length
          ? null
          : 'One or more test cases failed.',
      passedTests,
      totalTests: testCases.length,
      passPercentage,
      totalPassedRuntimeMs,
      results,
    };
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
