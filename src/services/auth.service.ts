// Authentication building blocks: password hashing, JWTs and Google ID-token verification.
// No HTTP and no database in here, so it can be tested on its own.
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { isValidUserId } from '../validation/auth.validation.js';

const secretFromEnv = process.env.JWT_SECRET;
if (!secretFromEnv) throw new Error('JWT_SECRET is not set');
const jwtSecret: string = secretFromEnv;

/** Token (and cookie) lifetime: 7 days. */
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// ---------- passwords ----------

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

/** Returns "salt:hash" (hex). Every password gets its own random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Constant-time comparison against a stored "salt:hash". */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------- JWT ----------

/** Signs a token whose subject is the user id. */
export const signToken = (userId: string): string =>
  jwt.sign({}, jwtSecret, { subject: userId, expiresIn: TOKEN_TTL_SECONDS, algorithm: 'HS256' });

/** Verifies signature, algorithm and expiry. Returns the user id, or null if the token is not acceptable. */
export function verifyToken(token: string): string | null {
  try {
    // algorithms is pinned so a token cannot pick its own (e.g. "none")
    const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string') return null;
    return typeof payload.sub === 'string' && isValidUserId(payload.sub) ? payload.sub : null;
  } catch {
    return null; // bad signature, expired, malformed...
  }
}

// ---------- password reset ----------

// Reset links are signed with a key of their own, derived from JWT_SECRET. A login token and a reset token
// can therefore never be used for each other, although both are JWTs whose subject is the user id.
const resetSecret = createHmac('sha256', jwtSecret).update('password-reset').digest();

/** A reset link works for one hour. */
export const RESET_TTL_SECONDS = 60 * 60;

/**
 * Identifies the password a reset link was made for. It is inside the token, so the link stops working as
 * soon as the password changes: a reset link can only be used once, and needs no table in the database.
 */
export const passwordFingerprint = (passwordHash: string | undefined): string =>
  createHash('sha256').update(passwordHash ?? '').digest('hex').slice(0, 16);

export const signResetToken = (userId: string, passwordHash: string | undefined): string =>
  jwt.sign({ pw: passwordFingerprint(passwordHash) }, resetSecret, {
    subject: userId,
    expiresIn: RESET_TTL_SECONDS,
    algorithm: 'HS256',
  });

/** The user id and password fingerprint inside a reset token, or null if it is not acceptable (bad, expired...). */
export function verifyResetToken(token: string): { userId: string; fingerprint: string } | null {
  try {
    const payload = jwt.verify(token, resetSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string') return null;
    if (typeof payload.sub !== 'string' || !isValidUserId(payload.sub) || typeof payload.pw !== 'string') return null;
    return { userId: payload.sub, fingerprint: payload.pw };
  } catch {
    return null;
  }
}

// ---------- Google sign-in ----------

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;

/** Google sign-in is optional: without GOOGLE_CLIENT_ID the endpoint answers 503. */
export const isGoogleAuthConfigured = googleClient !== null;

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/**
 * Checks an ID token from Google Identity Services (signature, expiry, issuer, and that it was
 * issued for OUR client id). Returns the profile, or null if the token is not valid.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile | null> {
  if (!googleClient || !googleClientId) return null;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) return null;
    return {
      googleId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      ...(payload.name ? { name: payload.name } : {}),
      ...(payload.picture ? { picture: payload.picture } : {}),
    };
  } catch {
    return null;
  }
}
