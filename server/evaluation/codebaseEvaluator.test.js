import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  classifyExecutionFailure,
  evaluateCodebase,
  formatTestResult,
  normaliseOutput,
  validateCodebaseTree,
} from './codebaseEvaluator.js';

const file = (name, content = '') => ({ type: 'file', name, content });
const project = (...children) => ({ type: 'directory', children });

// The grading tests that run code need the Docker sandbox
const skipWithoutDocker =
  spawnSync('docker', ['info'], { timeout: 20000 }).status !== 0
    ? 'Docker is not running'
    : false;

const tests = [
  { input: '3\n', expectedOutput: '6\n', hidden: false, timeLimit: 5000 },
  { input: '4\n', expectedOutput: '8\n', hidden: true, timeLimit: 5000 },
];

test('accepts a normal codebase', () => {
  assert.equal(
    validateCodebaseTree({
      type: 'directory',
      children: [
        file('main.py', 'def main():\n    pass\n'),
        { type: 'directory', name: 'lib', children: [file('util.py')] },
      ],
    }),
    null
  );
});

test('rejects path traversal, duplicates and bad types', () => {
  const tree = (children) => ({ type: 'directory', children });

  assert.match(validateCodebaseTree(tree([file('../x')])), /Invalid/);
  assert.match(validateCodebaseTree(tree([file('a/b')])), /Invalid/);
  assert.match(
    validateCodebaseTree(tree([file('Main.py'), file('main.py')])),
    /Duplicate/
  );
  assert.match(
    validateCodebaseTree(tree([{ type: 'link', name: 'x' }])),
    /Invalid node type/
  );
  assert.match(
    validateCodebaseTree(tree([{ type: 'file', name: 'x', content: 5 }])),
    /must be text/
  );
  assert.match(validateCodebaseTree({}), /valid codebase/);
});

test('output comparison ignores CRLF and trailing whitespace', () => {
  assert.equal(normaliseOutput('1 2  \r\n3\r\n\r\n'), '1 2\n3');
  assert.equal(normaliseOutput(undefined), '');
  assert.notEqual(normaliseOutput(' 1'), normaliseOutput('1'));
});

test('a missing main.py fails every test with its own result', async () => {
  const report = await evaluateCodebase(project(file('other.py')), tests);

  assert.equal(report.passed, false);
  assert.equal(report.reason, 'main.py is missing.');
  assert.equal(report.passPercentage, 0);
  assert.equal(report.results.length, 2);
  assert.deepEqual(report.results[0], {
    passed: false,
    hidden: false,
    runtimeMs: 0,
    reason: 'main.py is missing.',
    input: '3\n',
  });
  // Hidden tests only report the reason
  assert.deepEqual(report.results[1], {
    passed: false,
    hidden: true,
    runtimeMs: 0,
    reason: 'main.py is missing.',
  });
});

test('a main.py directory counts as missing, not a crash', async () => {
  const report = await evaluateCodebase(
    project({ type: 'directory', name: 'main.py', children: [] }),
    tests
  );

  assert.equal(report.reason, 'main.py is missing.');
  assert.equal(report.results.length, 2);
});

test(
  'calls main() once, even without a __main__ guard',
  { skip: skipWithoutDocker },
  async () => {
    const source = 'def main():\n    n = int(input())\n    print(n * 2)\n';
    const report = await evaluateCodebase(
      project(file('main.py', source)),
      tests
    );

    assert.equal(report.passed, true);
    assert.equal(report.passedTests, 2);
    assert.equal(report.reason, null);
  }
);

test(
  'a __main__ guard does not make main() run twice',
  { skip: skipWithoutDocker },
  async () => {
    const source =
      'def main():\n    print(int(input()) * 2)\n\n' +
      'if __name__ == "__main__":\n    main()\n';
    const report = await evaluateCodebase(
      project(file('main.py', source)),
      tests
    );

    assert.equal(report.passed, true);
  }
);

test(
  'reports an undefined main() on every test without leaking',
  { skip: skipWithoutDocker },
  async () => {
    const report = await evaluateCodebase(
      project(file('main.py', 'print("hi")\n')),
      tests
    );

    assert.equal(report.passed, false);
    assert.equal(report.reason, 'main() is not defined.');
    assert.equal(report.results.length, 2);
    assert.equal(report.results[0].reason, 'main() is not defined.');
    assert.equal(report.results[1].reason, 'main() is not defined.');
    assert.equal(report.results[1].input, undefined);
    assert.equal(report.results[1].expectedOutput, undefined);
  }
);

test(
  'a main imported from another module counts as defined',
  { skip: skipWithoutDocker },
  async () => {
    const report = await evaluateCodebase(
      project(
        file('main.py', 'from solution import main\n'),
        file('solution.py', 'def main():\n    print(int(input()) * 2)\n')
      ),
      tests
    );

    assert.equal(report.passed, true);
  }
);

test(
  'sys.exit(97) in user code is a runtime error, not a missing main()',
  { skip: skipWithoutDocker },
  async () => {
    const report = await evaluateCodebase(
      project(file('main.py', 'import sys\ndef main():\n    sys.exit(97)\n')),
      tests
    );

    assert.equal(report.results[0].reason, 'Runtime error.');
  }
);

const ran = (overrides = {}) => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  outputExceeded: false,
  oomKilled: false,
  runtimeMs: 10,
  ...overrides,
});

test('classifies how a run failed', () => {
  assert.equal(classifyExecutionFailure(ran()), null);
  assert.equal(
    classifyExecutionFailure(ran({ timedOut: true, exitCode: 124 })),
    'Time limit exceeded.'
  );
  assert.equal(
    classifyExecutionFailure(ran({ outputExceeded: true })),
    'Output limit exceeded.'
  );
  // Killed by the kernel for using too much memory (exit code 137)
  assert.equal(
    classifyExecutionFailure(ran({ exitCode: 137, oomKilled: true })),
    'Memory limit exceeded.'
  );
  assert.equal(
    classifyExecutionFailure(
      ran({ exitCode: 1, stderr: 'Traceback...\nMemoryError\n' })
    ),
    'Memory limit exceeded.'
  );
  assert.equal(
    classifyExecutionFailure(
      ran({ exitCode: 1, stderr: "RuntimeError: can't start new thread" })
    ),
    'Process limit exceeded.'
  );
  assert.equal(
    classifyExecutionFailure(ran({ exitCode: 1, stderr: 'ValueError: x' })),
    'Runtime error.'
  );
});

test('a failing hidden test never reveals its data', () => {
  const hiddenCase = {
    input: 'secret input',
    expectedOutput: 'secret answer',
    hidden: true,
  };
  const failure = formatTestResult(hiddenCase, {
    passed: false,
    runtimeMs: 12,
    reason: 'Incorrect output.',
    stdout: 'what the program printed',
    stderr: 'Traceback with secret answer',
  });

  assert.deepEqual(failure, {
    passed: false,
    hidden: true,
    runtimeMs: 12,
    reason: 'Incorrect output.',
  });
  assert.doesNotMatch(JSON.stringify(failure), /secret|printed/);
});

test('a failing visible test shows its input, and outputs on a mismatch', () => {
  const visibleCase = { input: '1', expectedOutput: '2', hidden: false };

  assert.deepEqual(
    formatTestResult(visibleCase, {
      passed: false,
      runtimeMs: 5,
      reason: 'Incorrect output.',
      stdout: '3',
    }),
    {
      passed: false,
      hidden: false,
      runtimeMs: 5,
      reason: 'Incorrect output.',
      input: '1',
      expectedOutput: '2',
      actualOutput: '3',
    }
  );

  // A crash shows the input but no expected or produced output
  const crash = formatTestResult(visibleCase, {
    passed: false,
    runtimeMs: 5,
    reason: 'Runtime error.',
    stdout: '3',
  });
  assert.equal(crash.input, '1');
  assert.equal(crash.expectedOutput, undefined);
  assert.equal(crash.actualOutput, undefined);
});

test(
  'a program using too much memory is reported as such',
  { skip: skipWithoutDocker },
  async () => {
    const source = [
      'def main():',
      "    data = 'a' * (1024 * 1024 * 1024)",
      '    print(len(data))',
      '',
    ].join('\n');
    const report = await evaluateCodebase(project(file('main.py', source)), [
      tests[0],
    ]);

    assert.equal(report.passed, false);
    assert.equal(report.results[0].reason, 'Memory limit exceeded.');
  }
);

test(
  'a program starting too many threads hits the process limit',
  { skip: skipWithoutDocker },
  async () => {
    const source = [
      'import threading, time',
      'def main():',
      '    for _ in range(500):',
      '        threading.Thread(target=time.sleep, args=(3,)).start()',
      '',
    ].join('\n');
    const report = await evaluateCodebase(project(file('main.py', source)), [
      { ...tests[0], timeLimit: 8000 },
    ]);

    assert.equal(report.results[0].reason, 'Process limit exceeded.');
  }
);
