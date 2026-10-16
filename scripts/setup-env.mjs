/**
 * Creates server/.env from .env.example if missing, and makes sure
 * ENABLE_PYTHON_EXECUTION is present in an existing .env.
 * Run from the server directory (npm run env:setup --prefix server).
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  copyFileSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';

const PLACEHOLDER_SECRET = 'replace-with-a-long-random-string';

if (!existsSync('.env')) {
  if (existsSync('.env.example')) {
    copyFileSync('.env.example', '.env');
    console.log('.env created from .env.example');
  }
} else if (
  !/^ENABLE_PYTHON_EXECUTION\s*=/m.test(readFileSync('.env', 'utf8'))
) {
  appendFileSync('.env', '\nENABLE_PYTHON_EXECUTION=true\n');
  console.log('Added ENABLE_PYTHON_EXECUTION=true to .env');
}

// Replace the example JWT secret with a random one so nobody runs with a
// publicly known secret
if (existsSync('.env')) {
  const env = readFileSync('.env', 'utf8');
  if (env.includes(PLACEHOLDER_SECRET)) {
    writeFileSync(
      '.env',
      env.replace(PLACEHOLDER_SECRET, randomBytes(48).toString('hex'))
    );
    console.log('Generated a random JWT_SECRET in .env');
  }
}
