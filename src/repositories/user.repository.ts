import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from '../db.js';

export interface User {
  email: string;
  displayName: string;
  passwordHash?: string;
  googleId?: string;
  avatarUrl?: string; // the picture the user chose: uploaded here (/uploads/avatars/...) or, for older accounts, a Google link
  googlePicture?: string; // the picture of the Google account, refreshed at every Google sign-in; never deleted by the user
  createdAt: Date;
  updatedAt: Date;
}

export type UserDoc = WithId<User>;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string; // the picture to show: the chosen one, else the Google one
  hasCustomAvatar: boolean; // true when the user uploaded one (so there is something to remove)
  createdAt: Date;
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash?: string;
  googleId?: string;
  googlePicture?: string;
}

export interface UserUpdate {
  displayName?: string;
  avatarUrl?: string | null;
}

const users = (): Collection<User> => getDb().collection<User>('users');

const UPLOADED_AVATAR_PREFIX = '/uploads/avatars/';

/** True for a picture that was uploaded to this server (not a link to somewhere else). */
export const isUploadedAvatar = (avatarUrl: string | undefined): avatarUrl is string =>
  typeof avatarUrl === 'string' && avatarUrl.startsWith(UPLOADED_AVATAR_PREFIX);

export const toPublicUser = ({ _id, email, displayName, avatarUrl, googlePicture, createdAt }: UserDoc): PublicUser => {
  const shown = avatarUrl ?? googlePicture;
  return {
    id: _id.toString(),
    email,
    displayName,
    createdAt,
    hasCustomAvatar: isUploadedAvatar(avatarUrl),
    ...(shown ? { avatarUrl: shown } : {}),
  };
};

/** True for the error MongoDB throws when a unique index is violated. */
export const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

/** Call once after connectDB(): uniqueness is enforced by the database, not by a racy pre-check. */
export async function ensureUserIndexes(): Promise<void> {
  await users().createIndex({ email: 1 }, { unique: true });
  await users().createIndex(
    { googleId: 1 },
    { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } },
  );
}

/** Throws a duplicate key error (see isDuplicateKeyError) if the email or Google id is taken. */
export async function createUser(newUser: NewUser): Promise<UserDoc> {
  const now = new Date();
  const user: User = { ...newUser, createdAt: now, updatedAt: now };
  const result = await users().insertOne(user);
  return { _id: result.insertedId, ...user };
}

export function findUserById(id: string): Promise<UserDoc | null> {
  return users().findOne({ _id: new ObjectId(id) });
}

export function findUserByEmail(email: string): Promise<UserDoc | null> {
  return users().findOne({ email });
}

export function findUserByGoogleId(googleId: string): Promise<UserDoc | null> {
  return users().findOne({ googleId });
}

/** Attaches a Google account to an existing user. Returns the updated user, or null if not found. */
export function linkGoogleAccount(id: string, googleId: string, googlePicture?: string): Promise<UserDoc | null> {
  return users().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { googleId, updatedAt: new Date(), ...(googlePicture ? { googlePicture } : {}) } },
    { returnDocument: 'after' },
  );
}

/** Remembers the picture of the user's Google account (it can change at Google). Returns the updated user. */
export function setGooglePicture(id: string, googlePicture: string): Promise<UserDoc | null> {
  return users().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { googlePicture, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

export function updateUser(id: string, changes: UserUpdate): Promise<UserDoc | null> {
  const set: Partial<User> = { updatedAt: new Date() };
  if (changes.displayName !== undefined) set.displayName = changes.displayName;
  if (typeof changes.avatarUrl === 'string') set.avatarUrl = changes.avatarUrl;

  return users().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: set, ...(changes.avatarUrl === null ? { $unset: { avatarUrl: '' as const } } : {}) },
    { returnDocument: 'after' },
  );
}

export async function deleteUser(id: string): Promise<boolean> {
  const result = await users().deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount > 0;
}
