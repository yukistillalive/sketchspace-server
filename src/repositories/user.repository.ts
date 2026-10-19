import { ObjectId, type Collection } from 'mongodb';
import { getDb } from '../db.js';
import type { NewUser, User, UserDoc, UserUpdate } from '../models/user.model.js';

const users = (): Collection<User> => getDb().collection<User>('users');

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

/**
 * Replaces the password, but only if the user still has the password the reset link was made for
 * (undefined: an account that has none yet, e.g. a Google account). Returns false if it no longer matches.
 */
export async function setPasswordHash(id: string, passwordHash: string, expectedOldHash: string | undefined): Promise<boolean> {
  const result = await users().updateOne(
    { _id: new ObjectId(id), passwordHash: expectedOldHash ?? { $exists: false } },
    { $set: { passwordHash, updatedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

export async function deleteUser(id: string): Promise<boolean> {
  const result = await users().deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount > 0;
}
