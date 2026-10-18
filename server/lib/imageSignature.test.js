import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hasImageSignature, matchesImageSignature } from './imageSignature.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a......');
const WEBP = Buffer.from('RIFF....WEBP');

test('recognises the first bytes of each supported image type', () => {
  assert.equal(matchesImageSignature(PNG, 'image/png'), true);
  assert.equal(matchesImageSignature(JPEG, 'image/jpeg'), true);
  assert.equal(matchesImageSignature(GIF, 'image/gif'), true);
  assert.equal(
    matchesImageSignature(Buffer.from('GIF87a......'), 'image/gif'),
    true
  );
  assert.equal(matchesImageSignature(WEBP, 'image/webp'), true);
});

test('rejects a file whose bytes do not match the claimed type', () => {
  // A script renamed to .png, and one image type claiming to be another
  assert.equal(
    matchesImageSignature(
      Buffer.from('<script>alert(1)</script>'),
      'image/png'
    ),
    false
  );
  assert.equal(matchesImageSignature(PNG, 'image/jpeg'), false);
  assert.equal(matchesImageSignature(Buffer.alloc(0), 'image/png'), false);
  assert.equal(matchesImageSignature(PNG, 'image/svg+xml'), false);
});

test('reads the signature from a file on disk', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cs343-image-'));
  try {
    const real = path.join(directory, 'real.png');
    const fake = path.join(directory, 'fake.png');
    await writeFile(real, PNG);
    await writeFile(fake, 'not an image');

    assert.equal(await hasImageSignature(real, 'image/png'), true);
    assert.equal(await hasImageSignature(fake, 'image/png'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
