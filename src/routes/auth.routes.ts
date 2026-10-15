import { Router, type Response } from 'express';
import {
  hashPassword,
  isGoogleAuthConfigured,
  signToken,
  TOKEN_TTL_SECONDS,
  verifyGoogleIdToken,
  verifyPassword,
  type GoogleProfile,
} from '../services/auth.service.js';
import { optionalUserId, TOKEN_COOKIE } from '../middleware/auth.middleware.js';
import * as repo from '../repositories/user.repository.js';
import {
  isValidDisplayName,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  toDisplayName,
} from '../validation/auth.validation.js';

export const authRouter = Router();

const isProduction = process.env.NODE_ENV === 'production';

// httpOnly: not readable from JavaScript. In production the frontend is on another origin,
// so the cookie must be sameSite=none (which requires https / secure).
const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? ('none' as const) : ('lax' as const),
  path: '/',
};

// Checked against when the email is unknown, so "no such user" and "wrong password"
// take the same time and cannot be told apart.
const DUMMY_HASH = await hashPassword('not-a-real-password-1');

/** Signs the user in: sets the cookie and returns the body the clients receive. */
function startSession(res: Response, user: repo.UserDoc) {
  const token = signToken(user._id.toString());
  res.cookie(TOKEN_COOKIE, token, { ...cookieOptions, maxAge: TOKEN_TTL_SECONDS * 1000 });
  return { user: repo.toPublicUser(user), token };
}

export const clearSessionCookie = (res: Response): void => {
  res.clearCookie(TOKEN_COOKIE, cookieOptions);
};

// POST /api/auth/register  { email, password, displayName }
authRouter.post('/register', async (req, res) => {
  const { email, password, displayName } = (req.body ?? {}) as Record<string, unknown>;
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (!isValidPassword(password))
    return res
      .status(400)
      .json({ error: 'Password must be 8-128 characters and contain a letter and a digit' });
  if (!isValidDisplayName(displayName))
    return res.status(400).json({
      error: 'Display name must be 2-30 characters: letters, digits, spaces, _ . -',
    });

  try {
    const user = await repo.createUser({
      email: normalizeEmail(email),
      displayName,
      passwordHash: await hashPassword(password),
    });
    res.status(201).json(startSession(res, user));
  } catch (err) {
    if (repo.isDuplicateKeyError(err)) return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
});

// POST /api/auth/login  { email, password }
authRouter.post('/login', async (req, res) => {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>;
  if (!isValidEmail(email) || typeof password !== 'string' || password.length === 0)
    return res.status(400).json({ error: 'Email and password are required' });

  const user = await repo.findUserByEmail(normalizeEmail(email));
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  // Google-only accounts have no passwordHash, so they cannot log in with a password.
  if (!user || !user.passwordHash || !passwordMatches)
    return res.status(401).json({ error: 'Invalid email or password' });

  res.json(startSession(res, user));
});

/** Finds the user for a verified Google profile: by Google id, else by email (linking), else creates one. */
async function resolveGoogleUser(profile: GoogleProfile): Promise<{ user: repo.UserDoc; created: boolean } | null> {
  const byGoogleId = await repo.findUserByGoogleId(profile.googleId);
  if (byGoogleId) return { user: byGoogleId, created: false };

  const email = normalizeEmail(profile.email);
  const byEmail = await repo.findUserByEmail(email);
  if (byEmail) {
    // Same verified email: attach the Google account to the existing user.
    const linked = await repo.linkGoogleAccount(byEmail._id.toString(), profile.googleId, profile.picture);
    return linked ? { user: linked, created: false } : null;
  }

  const user = await repo.createUser({
    email,
    displayName: toDisplayName(profile.name, email),
    googleId: profile.googleId,
    ...(profile.picture ? { avatarUrl: profile.picture } : {}),
  });
  return { user, created: true };
}

// POST /api/auth/google  { idToken }   (idToken = the "credential" from Google Identity Services)
authRouter.post('/google', async (req, res) => {
  if (!isGoogleAuthConfigured) return res.status(503).json({ error: 'Google sign-in is not configured' });

  const { idToken } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof idToken !== 'string' || idToken.length === 0)
    return res.status(400).json({ error: 'idToken is required' });

  const profile = await verifyGoogleIdToken(idToken);
  if (!profile) return res.status(401).json({ error: 'Invalid Google credential' });
  if (!profile.emailVerified) return res.status(401).json({ error: 'Google email is not verified' });

  try {
    const result = await resolveGoogleUser(profile);
    if (!result) return res.status(401).json({ error: 'Invalid Google credential' });
    res.status(result.created ? 201 : 200).json(startSession(res, result.user));
  } catch (err) {
    // two first sign-ins racing each other hit the unique index
    if (repo.isDuplicateKeyError(err)) return res.status(409).json({ error: 'Account already exists, try again' });
    throw err;
  }
});

// GET /api/auth/session  ->  { user } for a logged-in user, { user: null } for a guest.
// The frontend asks this every time it opens. A guest gets 200 here (GET /api/users/me would answer 401),
// so the browser does not print a red error in the console on every visit of someone who is not logged in.
authRouter.get('/session', async (req, res) => {
  const userId = optionalUserId(req);
  const user = userId ? await repo.findUserById(userId) : null;
  res.json({ user: user ? repo.toPublicUser(user) : null });
});

// POST /api/auth/logout  (clears the cookie; a copy of the token stays valid until it expires)
authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
