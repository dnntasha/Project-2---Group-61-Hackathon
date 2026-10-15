/**
 * Creates server/.env from .env.example if missing, and makes sure
 * ENABLE_PYTHON_EXECUTION is present in an existing .env.
 * Run from the server directory (npm run env:setup --prefix server).
 */
import {
  existsSync,
  copyFileSync,
  readFileSync,
  appendFileSync,
} from 'node:fs';

if (!existsSync('.env')) {
  if (existsSync('.env.example')) {
    copyFileSync('.env.example', '.env');
    console.log('.env created from .env.example');
  }
} else if (!/^ENABLE_PYTHON_EXECUTION=/m.test(readFileSync('.env', 'utf8'))) {
  appendFileSync('.env', '\nENABLE_PYTHON_EXECUTION=true\n');
  console.log('Added ENABLE_PYTHON_EXECUTION=true to .env');
}
