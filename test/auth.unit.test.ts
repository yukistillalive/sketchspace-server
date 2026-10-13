// Pure tests: no database, no server. Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET ??= 'test-secret'; // auth.service.ts reads this when first imported

const { hashPassword, verifyPassword, signToken, verifyToken } = await import('../src/services/auth.service.js');
const v = await import('../src/validation/auth.validation.js');

const userId = '6abe45dcc09e70d0e46e4bbb';

describe('validation (regex input filtering)', () => {
  it('accepts a normal email and rejects malformed ones', () => {
    assert.equal(v.isValidEmail('maryam@example.com'), true);
    for (const bad of ['', 'plain', 'a@b', 'a b@c.com', '@c.com', 'a@@c.com', 'a@c.c', 42, null])
      assert.equal(v.isValidEmail(bad), false, String(bad));
  });

  it('requires a password of 8+ characters with a letter and a digit', () => {
    assert.equal(v.isValidPassword('sketch123'), true);
    for (const bad of ['short1', 'onlyletters', '12345678', 'a'.repeat(129) + '1', undefined])
      assert.equal(v.isValidPassword(bad), false, String(bad));
  });

  it('restricts display names to letters, digits, space and _ . -', () => {
    assert.equal(v.isValidDisplayName('Yuki_42'), true);
    assert.equal(v.isValidDisplayName('Élodie Martin'), true);
    for (const bad of ['a', '-lead', 'x'.repeat(31), '<script>', 'name!'])
      assert.equal(v.isValidDisplayName(bad), false, bad);
  });

  it('allows only https avatar urls', () => {
    assert.equal(v.isValidAvatarUrl('https://example.com/a.png'), true);
    for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'https://a b', ''])
      assert.equal(v.isValidAvatarUrl(bad), false, bad);
  });

  it('normalizes emails and cleans names coming from Google', () => {
    assert.equal(v.normalizeEmail('  Maryam@Example.COM '), 'maryam@example.com');
    assert.equal(v.toDisplayName('Ada <b>Lovelace</b>', 'ada@x.com'), 'Ada bLovelaceb');
    assert.equal(v.toDisplayName('!!', 'ada.l@x.com'), 'ada.l');
    assert.equal(v.toDisplayName(undefined, '!!@x.com'), 'Artist');
  });
});

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('sketch123');
    assert.equal(await verifyPassword('sketch123', stored), true);
    assert.equal(await verifyPassword('sketch124', stored), false);
  });

  it('salts: the same password hashes differently each time, and is never stored in clear', async () => {
    const [a, b] = await Promise.all([hashPassword('sketch123'), hashPassword('sketch123')]);
    assert.notEqual(a, b);
    assert.ok(!a.includes('sketch123'));
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.equal(await verifyPassword('x', ''), false);
  });
});

describe('JWT', () => {
  it('round-trips the user id', () => {
    assert.equal(verifyToken(signToken(userId)), userId);
  });

  it('rejects a token signed with another secret', () => {
    const forged = jwt.sign({}, 'another-secret', { subject: userId, algorithm: 'HS256' });
    assert.equal(verifyToken(forged), null);
  });

  it('rejects a tampered payload', () => {
    const [h, , s] = signToken(userId).split('.');
    const payload = Buffer.from(JSON.stringify({ sub: '000000000000000000000000' })).toString('base64url');
    assert.equal(verifyToken(`${h}.${payload}.${s}`), null);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({}, process.env.JWT_SECRET!, { subject: userId, expiresIn: -10 });
    assert.equal(verifyToken(expired), null);
  });

  it('rejects an unsigned ("alg: none") token', () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    assert.equal(verifyToken(`${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: userId })}.`), null);
  });

  it('rejects a token whose subject is not a user id, and garbage', () => {
    assert.equal(verifyToken(jwt.sign({}, process.env.JWT_SECRET!, { subject: 'admin' })), null);
    assert.equal(verifyToken('not.a.token'), null);
    assert.equal(verifyToken(''), null);
  });
});
