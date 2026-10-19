// Pure tests for the reset-link tokens: no database, no server.
// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-secret'; // auth.service.ts reads this when first imported
const { RESET_TTL_SECONDS, passwordFingerprint, signResetToken, signToken, verifyResetToken, verifyToken } = await import(
  '../src/services/auth.service.js'
);

const userId = '6abe45dcc09e70d0e46e4bbb';
const hash = 'aabbcc:ddeeff';

describe('passwordFingerprint', () => {
  it('is the same for the same password and different for another one', () => {
    assert.equal(passwordFingerprint(hash), passwordFingerprint(hash));
    assert.notEqual(passwordFingerprint(hash), passwordFingerprint('112233:445566'));
  });

  it('also works for an account that has no password yet', () => {
    assert.match(passwordFingerprint(undefined), /^[0-9a-f]{16}$/);
    assert.notEqual(passwordFingerprint(undefined), passwordFingerprint(hash));
  });

  it('does not reveal the hash', () => {
    assert.ok(!passwordFingerprint(hash).includes('aabbcc'));
  });
});

describe('reset tokens', () => {
  it('give back the user id and the fingerprint of the password they were made for', () => {
    const claims = verifyResetToken(signResetToken(userId, hash));
    assert.deepEqual(claims, { userId, fingerprint: passwordFingerprint(hash) });
  });

  it('last one hour', () => {
    assert.equal(RESET_TTL_SECONDS, 3600);
    const payload = jwt.decode(signResetToken(userId, hash)) as { iat: number; exp: number };
    assert.equal(payload.exp - payload.iat, 3600);
  });

  it('are refused when changed, when expired, or when empty or random text', () => {
    const token = signResetToken(userId, hash);
    const [header, body, signature] = token.split('.');
    assert.equal(verifyResetToken(`${header}.${body}.${signature?.slice(0, -2)}xx`), null);
    assert.equal(verifyResetToken(''), null);
    assert.equal(verifyResetToken('not a token'), null);

    const resetKey = createHmac('sha256', 'test-secret').update('password-reset').digest();
    const expired = jwt.sign({ pw: passwordFingerprint(hash) }, resetKey, { subject: userId, expiresIn: -10 });
    assert.equal(verifyResetToken(expired), null);
  });

  it('are refused when they have no password fingerprint or a user id that is not one', () => {
    const resetKey = createHmac('sha256', 'test-secret').update('password-reset').digest();
    assert.equal(verifyResetToken(jwt.sign({}, resetKey, { subject: userId, expiresIn: 60 })), null);
    assert.equal(verifyResetToken(jwt.sign({ pw: 'x' }, resetKey, { subject: 'nobody', expiresIn: 60 })), null);
  });

  it('cannot be used as a login token, and a login token cannot be used to reset a password', () => {
    assert.equal(verifyToken(signResetToken(userId, hash)), null);
    assert.equal(verifyResetToken(signToken(userId)), null);
  });
});
