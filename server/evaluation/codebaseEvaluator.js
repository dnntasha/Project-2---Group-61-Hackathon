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

export async function removeTemporaryCodebase(temporaryDirectory) {
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
  });
}
