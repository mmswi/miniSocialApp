import { describe, expect, test } from 'bun:test';
import { hashPassword, isPasswordCorrect } from './password.ts';

describe('password hashing', () => {
  test('accepts the correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await isPasswordCorrect(stored, 'correct horse battery staple')).toBe(true);
  });

  test('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await isPasswordCorrect(stored, 'wrong password')).toBe(false);
  });

  test('uses a random salt — the same input hashes differently each time', async () => {
    const first = await hashPassword('same input');
    const second = await hashPassword('same input');
    expect(first).not.toBe(second);
  });
});
