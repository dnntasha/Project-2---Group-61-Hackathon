import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeDockerPythonFile } from './dockerSandbox.js';

const directory = await mkdtemp(path.join(tmpdir(), 'cs343-docker-test-'));

try {
  await writeFile(
    path.join(directory, 'main.py'),
    'while True:\n    print("A" * 1000, flush=True)\n'
  );

  const result = await executeDockerPythonFile('main.py', '', 2000, directory);

  console.log(result);
} finally {
  await rm(directory, { recursive: true, force: true });
}
