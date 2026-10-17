import type { UserUpdate } from '../models/user.model.js';

// Regex-based input filtering. Everything a client sends for accounts goes through here
// before it is stored: clients are untrusted.

// local part (max 64 chars, no spaces/@) @ domain . tld (2+ chars)
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
// 8-128 chars with at least one letter and one digit
const PASSWORD_RE = /^(?=.*\p{L})(?=.*\d).{8,128}$/u;
// 2-30 chars: letters, digits, space, _ . - ; must start with a letter or digit
const DISPLAY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,29}$/u;
// https only, no whitespace
const AVATAR_URL_RE = /^https:\/\/\S{1,500}$/;
// an uploaded avatar: png/jpeg/webp image as a base64 data URL
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
// max length of an avatar data URL (~200KB of text, about 150KB of image)
export const MAX_AVATAR_DATA_URL_LENGTH = 200 * 1024;
// a MongoDB ObjectId as a string
const USER_ID_RE = /^[0-9a-f]{24}$/i;
// characters not allowed in a display name (used to clean names coming from Google)
const DISPLAY_NAME_FORBIDDEN_RE = /[^\p{L}\p{N} _.-]/gu;

export const isValidEmail = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);

export const isValidPassword = (v: unknown): v is string => typeof v === 'string' && PASSWORD_RE.test(v);

export const isValidDisplayName = (v: unknown): v is string =>
  typeof v === 'string' && DISPLAY_NAME_RE.test(v);

/** Why an avatarUrl is rejected, or null if it is an https URL or a small png/jpeg/webp data URL. */
export function avatarUrlError(v: unknown): string | null {
  if (typeof v !== 'string') return 'avatarUrl must be a string, or null to remove it';
  if (v.startsWith('data:')) {
    if (v.length > MAX_AVATAR_DATA_URL_LENGTH) return 'avatarUrl data URL is too large (max 200KB)';
    if (!AVATAR_DATA_URL_RE.test(v))
      return 'avatarUrl data URL must be data:image/png, data:image/jpeg or data:image/webp with base64 data';
    return null;
  }
  return AVATAR_URL_RE.test(v) ? null : 'avatarUrl must be an https URL or an image data URL';
}

export const isValidAvatarUrl = (v: unknown): v is string => avatarUrlError(v) === null;

export const isValidUserId = (v: unknown): v is string => typeof v === 'string' && USER_ID_RE.test(v);

/** Emails are compared case-insensitively, so they are stored trimmed and lower-case. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Turns a free-form name (e.g. from Google) into a valid display name, with fallbacks. */
export function toDisplayName(name: string | undefined, email: string): string {
  const fromName = (name ?? '').replace(DISPLAY_NAME_FORBIDDEN_RE, '').trim().slice(0, 30);
  if (isValidDisplayName(fromName)) return fromName;
  const fromEmail = (email.split('@')[0] ?? '').replace(DISPLAY_NAME_FORBIDDEN_RE, '').slice(0, 30);
  return isValidDisplayName(fromEmail) ? fromEmail : 'Artist';
}

const PROFILE_UPDATE_HINT =
  'Provide displayName (2-30 characters) and/or avatarUrl (https URL, image data URL, or null)';

/** Picks and checks the editable profile fields. Returns the changes, or the message to answer with. */
export function parseProfileUpdate(body: unknown): { update: UserUpdate } | { error: string } {
  const { displayName, avatarUrl } = (body ?? {}) as Record<string, unknown>;
  if (displayName !== undefined && !isValidDisplayName(displayName)) return { error: PROFILE_UPDATE_HINT };
  if (avatarUrl !== undefined && avatarUrl !== null) {
    const problem = avatarUrlError(avatarUrl);
    if (problem) return { error: problem };
  }
  if (displayName === undefined && avatarUrl === undefined) return { error: PROFILE_UPDATE_HINT };
  return { update: { displayName, avatarUrl } as UserUpdate };
}
