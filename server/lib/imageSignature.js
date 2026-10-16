import { open } from 'node:fs/promises';

// How many leading bytes are needed to recognise every supported format
const SIGNATURE_BYTES = 12;

// True when `bytes` starts with the signature of the image type `mimeType`
// (PNG, JPEG, GIF or WebP). The Content-Type a browser sends is just a claim,
// so uploads are checked against the file's actual first bytes.
export function matchesImageSignature(bytes, mimeType) {
  const startsWith = (...expected) =>
    expected.every((byte, index) => bytes[index] === byte);

  switch (mimeType) {
    case 'image/png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case 'image/gif':
      // "GIF87a" or "GIF89a"
      return (
        startsWith(0x47, 0x49, 0x46, 0x38) &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
      );
    case 'image/webp':
      // "RIFF" <size> "WEBP"
      return (
        startsWith(0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
}

// Reads the start of the file at `filePath` and checks it against `mimeType`
export async function hasImageSignature(filePath, mimeType) {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(SIGNATURE_BYTES);
    const { bytesRead } = await file.read(buffer, 0, SIGNATURE_BYTES, 0);
    return matchesImageSignature(buffer.subarray(0, bytesRead), mimeType);
  } finally {
    await file.close();
  }
}
