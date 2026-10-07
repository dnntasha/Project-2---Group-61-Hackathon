import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPython } from './pythonRunner.js';

test('runs Python and captures standard output and errors', async () => {
  const result = await runPython(
    'import sys\nprint("hello")\nprint("warning", file=sys.stderr)\n'
  );

  assert.equal(result.stdout.replace(/\r\n/g, '\n'), 'hello\n');
  assert.equal(result.stderr.replace(/\r\n/g, '\n'), 'warning\n');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('reports a non-zero Python exit code', async () => {
  const result = await runPython('raise SystemExit(3)\n');

  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test('stops code after the execution timeout', async () => {
  const result = await runPython('import time\ntime.sleep(10)\n');

  assert.equal(result.timedOut, true);
});

test('limits captured output', async () => {
  const result = await runPython('print("x" * 70000)\n');

  assert.equal(result.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024);
});
