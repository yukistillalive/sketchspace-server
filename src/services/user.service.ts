// Account rules: registering, signing in (password or Google), the profile, the avatar and deleting
// an account. The routes only translate the results below into HTTP responses and cookies.
import {
  createUser,
  deleteUser,
  findUserByEmail,
  findUserByGoogleId,
  findUserById,
  linkGoogleAccount,
  setGooglePicture,
  updateUser,
} from '../repositories/user.repository.js';
import { isDuplicateKeyError } from '../repositories/errors.js';
import { isUploadedAvatar, toPublicUser, type PublicUser, type UserDoc } from '../models/user.model.js';
import {
  hashPassword,
  isGoogleAuthConfigured,
  signToken,
  verifyGoogleIdToken,
  verifyPassword,
  type GoogleProfile,
} from './auth.service.js';
import { deleteAvatarFile, detectImageType, saveAvatarFile } from './avatar.service.js';
import { deleteCanvasesOfUser } from './canvas.service.js';
import { deleteFoldersOfUser } from './folder.service.js';
import {
  isValidDisplayName,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  parseProfileUpdate,
  toDisplayName,
} from '../validation/auth.validation.js';

/** Why a request was refused. `status` is the matching HTTP status for REST handlers. */
export type UserFailure = { ok: false; status: 400 | 401 | 409 | 415 | 503; error: string };

/** A successful sign-in: the user to show and the token that proves the login. */
export type Session = { ok: true; created: boolean; user: PublicUser; token: string };

const ACCOUNT_GONE: UserFailure = { ok: false, status: 401, error: 'Account no longer exists' };

// Checked against when the email is unknown, so "no such user" and "wrong password"
// take the same time and cannot be told apart.
const DUMMY_HASH = await hashPassword('not-a-real-password-1');

const startSession = (user: UserDoc, created = false): Session => ({
  ok: true,
  created,
  user: toPublicUser(user),
  token: signToken(user._id.toString()),
});

/** Creates a password account and signs it in. */
export async function register(input: unknown): Promise<Session | UserFailure> {
  const { email, password, displayName } = (input ?? {}) as Record<string, unknown>;
  if (!isValidEmail(email)) return { ok: false, status: 400, error: 'Invalid email' };
  if (!isValidPassword(password))
    return { ok: false, status: 400, error: 'Password must be 8-128 characters and contain a letter and a digit' };
  if (!isValidDisplayName(displayName))
    return { ok: false, status: 400, error: 'Display name must be 2-30 characters: letters, digits, spaces, _ . -' };

  try {
    const user = await createUser({
      email: normalizeEmail(email),
      displayName,
      passwordHash: await hashPassword(password),
    });
    return startSession(user, true);
  } catch (err) {
    if (isDuplicateKeyError(err)) return { ok: false, status: 409, error: 'Email already registered' };
    throw err;
  }
}

/** Signs in with email and password. */
export async function login(input: unknown): Promise<Session | UserFailure> {
  const { email, password } = (input ?? {}) as Record<string, unknown>;
  if (!isValidEmail(email) || typeof password !== 'string' || password.length === 0)
    return { ok: false, status: 400, error: 'Email and password are required' };

  const user = await findUserByEmail(normalizeEmail(email));
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  // Google-only accounts have no passwordHash, so they cannot log in with a password.
  if (!user || !user.passwordHash || !passwordMatches)
    return { ok: false, status: 401, error: 'Invalid email or password' };

  return startSession(user);
}

/** Finds the user for a verified Google profile: by Google id, else by email (linking), else creates one. */
async function resolveGoogleUser(profile: GoogleProfile): Promise<{ user: UserDoc; created: boolean } | null> {
  const byGoogleId = await findUserByGoogleId(profile.googleId);
  if (byGoogleId) {
    // keep the Google picture current; the picture the user chose is not touched
    const refreshed =
      profile.picture && profile.picture !== byGoogleId.googlePicture
        ? await setGooglePicture(byGoogleId._id.toString(), profile.picture)
        : null;
    return { user: refreshed ?? byGoogleId, created: false };
  }

  const email = normalizeEmail(profile.email);
  const byEmail = await findUserByEmail(email);
  if (byEmail) {
    // Same verified email: attach the Google account to the existing user.
    const linked = await linkGoogleAccount(byEmail._id.toString(), profile.googleId, profile.picture);
    return linked ? { user: linked, created: false } : null;
  }

  const user = await createUser({
    email,
    displayName: toDisplayName(profile.name, email),
    googleId: profile.googleId,
    ...(profile.picture ? { googlePicture: profile.picture } : {}),
  });
  return { user, created: true };
}

/** Signs in with the ID token Google Identity Services gave the frontend. */
export async function loginWithGoogle(input: unknown): Promise<Session | UserFailure> {
  if (!isGoogleAuthConfigured) return { ok: false, status: 503, error: 'Google sign-in is not configured' };

  const { idToken } = (input ?? {}) as Record<string, unknown>;
  if (typeof idToken !== 'string' || idToken.length === 0)
    return { ok: false, status: 400, error: 'idToken is required' };

  const profile = await verifyGoogleIdToken(idToken);
  if (!profile) return { ok: false, status: 401, error: 'Invalid Google credential' };
  if (!profile.emailVerified) return { ok: false, status: 401, error: 'Google email is not verified' };

  try {
    const result = await resolveGoogleUser(profile);
    if (!result) return { ok: false, status: 401, error: 'Invalid Google credential' };
    return startSession(result.user, result.created);
  } catch (err) {
    // two first sign-ins racing each other hit the unique index
    if (isDuplicateKeyError(err)) return { ok: false, status: 409, error: 'Account already exists, try again' };
    throw err;
  }
}

/** The user behind a login, or null for a guest (or a deleted account). */
export async function getSessionUser(userId: string | null): Promise<PublicUser | null> {
  const user = userId ? await findUserById(userId) : null;
  return user ? toPublicUser(user) : null;
}

export async function getProfile(userId: string): Promise<{ ok: true; user: PublicUser } | UserFailure> {
  const user = await findUserById(userId);
  return user ? { ok: true, user: toPublicUser(user) } : ACCOUNT_GONE;
}

/** Changes the display name and/or avatar link of the account. */
export async function updateProfile(userId: string, body: unknown): Promise<{ ok: true; user: PublicUser } | UserFailure> {
  const parsed = parseProfileUpdate(body);
  if ('error' in parsed) return { ok: false, status: 400, error: parsed.error };

  const user = await updateUser(userId, parsed.update);
  return user ? { ok: true, user: toPublicUser(user) } : ACCOUNT_GONE;
}

/** Saves an uploaded picture file and makes it the account's avatar. */
export async function uploadAvatar(userId: string, image: unknown): Promise<{ ok: true; user: PublicUser } | UserFailure> {
  if (!Buffer.isBuffer(image) || image.length === 0)
    return { ok: false, status: 415, error: 'Send the image as the request body (image/png, image/jpeg or image/webp)' };

  const extension = detectImageType(image);
  if (!extension) return { ok: false, status: 400, error: 'The file is not a valid PNG, JPEG or WebP image' };

  const before = await findUserById(userId);
  if (!before) return ACCOUNT_GONE;

  const avatarUrl = await saveAvatarFile(userId, image, extension);
  const user = await updateUser(userId, { avatarUrl });
  // older accounts kept their Google picture in avatarUrl: remember it before it is replaced, so it can come back
  if (user && before.avatarUrl && !isUploadedAvatar(before.avatarUrl) && !before.googlePicture)
    await setGooglePicture(userId, before.avatarUrl);
  if (!user) {
    await deleteAvatarFile(avatarUrl); // the account was deleted meanwhile
    return ACCOUNT_GONE;
  }
  await deleteAvatarFile(before.avatarUrl); // the picture it replaces
  const current = await findUserById(userId);
  return { ok: true, user: toPublicUser(current ?? user) };
}

/** Removes the uploaded picture (and its file); the Google picture, if any, shows again. */
export async function removeAvatar(userId: string): Promise<{ ok: true; user: PublicUser } | UserFailure> {
  const before = await findUserById(userId);
  if (!before) return ACCOUNT_GONE;

  const user = await updateUser(userId, { avatarUrl: null });
  if (!user) return ACCOUNT_GONE;
  await deleteAvatarFile(before.avatarUrl);
  return { ok: true, user: toPublicUser(user) };
}

/** Deletes the account with its avatar file, its canvases (and their strokes and elements) and its folders. */
export async function deleteAccount(userId: string): Promise<{ ok: true } | UserFailure> {
  const before = await findUserById(userId);
  if (!(await deleteUser(userId))) return ACCOUNT_GONE;
  await deleteAvatarFile(before?.avatarUrl);
  await deleteCanvasesOfUser(userId);
  await deleteFoldersOfUser(userId);
  return { ok: true };
}
