import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(
      verifyPassword('correct horse battery staple', stored),
    ).resolves.toBe(true);
    await expect(
      verifyPassword('correct horse battery stapl3', stored),
    ).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same'),
      hashPassword('same'),
    ]);
    expect(a).not.toBe(b);
  });

  it('treats a malformed stored hash as a failed match, not a crash', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', '$2b$10$bcrypt-style')).resolves.toBe(
      false,
    );
  });
});
