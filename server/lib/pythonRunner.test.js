import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runPython } from './pythonRunner.js';

// These tests need the Docker sandbox; skip them (rather than fail) when it
// is switched off or Docker isn't running
const skip =
  process.env.ENABLE_PYTHON_EXECUTION !== 'true'
    ? 'ENABLE_PYTHON_EXECUTION is not true'
    : spawnSync('docker', ['info'], { timeout: 20000 }).status !== 0
      ? 'Docker is not running'
      : false;

test(
  'runs Python and captures standard output and errors',
  { skip },
  async () => {
    const result = await runPython(
      'import sys\nprint("hello")\nprint("warning", file=sys.stderr)\n'
    );

    assert.equal(result.stdout.replace(/\r\n/g, '\n'), 'hello\n');
    assert.equal(result.stderr.replace(/\r\n/g, '\n'), 'warning\n');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  }
);

test('reports a non-zero Python exit code', { skip }, async () => {
  const result = await runPython('raise SystemExit(3)\n');

  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test('stops code after the execution timeout', { skip }, async () => {
  const result = await runPython('import time\ntime.sleep(10)\n');

  assert.equal(result.timedOut, true);
});

test('limits captured output', { skip }, async () => {
  const result = await runPython('print("x" * 70000)\n');

  assert.equal(result.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024);
});

test(
  'does not expose the server environment to user code',
  { skip },
  async () => {
    process.env.RUNNER_TEST_SECRET = 'top-secret';
    try {
      const result = await runPython(
        'import os\nprint(os.environ.get("RUNNER_TEST_SECRET"))\n'
      );

      assert.equal(result.stdout.trim(), 'None');
    } finally {
      delete process.env.RUNNER_TEST_SECRET;
    }
  }
);

test('kills processes spawned by user code on timeout', { skip }, async () => {
  const result = await runPython(
    'import subprocess, sys, time\n' +
      'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])\n' +
      'time.sleep(10)\n'
  );

  assert.equal(result.timedOut, true);
});

test('passes stdin to the program', { skip }, async () => {
  const result = await runPython('print(input()[::-1])\n', 'olleh\n');

  assert.equal(result.stdout.trim(), 'hello');
});

test('keeps multi-byte output intact', { skip }, async () => {
  const result = await runPython('print("é" * 5000)\n');

  assert.equal(result.stdout.trim(), 'é'.repeat(5000));
});
