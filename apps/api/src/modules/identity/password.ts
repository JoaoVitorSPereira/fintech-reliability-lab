import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

// argon2id with OWASP's baseline parameters (19 MiB, 2 passes, 1 lane).
// Memory-hard: GPU/ASIC cracking of a leaked table costs far more than with
// fast hashes. Node 24 ships argon2 in `crypto`, so no native dependency.
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1 } as const;
const TAG_LENGTH = 32;
const SALT_LENGTH = 16;

// PHC string format: params live next to the hash, so they can be raised later
// without breaking existing hashes.
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function b64(buffer: Buffer) {
  return buffer.toString('base64').replace(/=+$/, '');
}

async function derive(
  password: string,
  salt: Buffer,
  params: { memory: number; passes: number; parallelism: number },
  tagLength: number,
) {
  return argon2Async('argon2id', {
    message: password,
    nonce: salt,
    tagLength,
    ...params,
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, PARAMS, TAG_LENGTH);
  const { memory, passes, parallelism } = PARAMS;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const match = PHC_PATTERN.exec(stored);
  if (!match) return false;
  const [, memory, passes, parallelism, salt, expected] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const expectedHash = Buffer.from(expected, 'base64');
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64'),
    {
      memory: Number(memory),
      passes: Number(passes),
      parallelism: Number(parallelism),
    },
    expectedHash.length,
  );
  // Constant-time compare: no early exit that leaks how many bytes matched.
  return timingSafeEqual(actual, expectedHash);
}
