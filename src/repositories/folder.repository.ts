import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from '../db.js';

export interface Folder {
  /** The account the folder belongs to. Never sent to clients. */
  ownerUserId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export type FolderDoc = WithId<Folder>;

/** A folder as sent to clients: `id` instead of _id, and no owner (it is always the caller). */
export interface PublicFolder {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export const toPublicFolder = ({ _id, name, createdAt, updatedAt }: FolderDoc): PublicFolder => ({
  id: _id.toString(),
  name,
  createdAt,
  updatedAt,
});

const folders = (): Collection<Folder> => getDb().collection<Folder>('folders');

/**
 * Call once after connectDB(). One account cannot have two folders whose names differ only in case:
 * the index compares names case-insensitively (collation strength 2), so the database enforces it.
 */
export async function ensureFolderIndexes(): Promise<void> {
  await folders().createIndex(
    { ownerUserId: 1, name: 1 },
    { unique: true, collation: { locale: 'en', strength: 2 } },
  );
}

/** Throws a duplicate key error (see isDuplicateKeyError) if the account already has that name. */
export async function createFolder(ownerUserId: string, name: string): Promise<FolderDoc> {
  const now = new Date();
  const folder: Folder = { ownerUserId, name, createdAt: now, updatedAt: now };
  const result = await folders().insertOne(folder);
  return { _id: result.insertedId, ...folder };
}

/** The folders of an account, oldest first. */
export function listFoldersByOwner(ownerUserId: string): Promise<FolderDoc[]> {
  return folders().find({ ownerUserId }).sort({ createdAt: 1, _id: 1 }).toArray();
}

export function findFolder(id: string): Promise<FolderDoc | null> {
  return folders().findOne({ _id: new ObjectId(id) });
}

/** Returns the renamed folder, or null if not found. Throws a duplicate key error if the name is taken. */
export function renameFolder(id: string, name: string): Promise<FolderDoc | null> {
  return folders().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { name, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/** Returns false if no folder matched. */
export async function deleteFolder(id: string): Promise<boolean> {
  const result = await folders().deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount > 0;
}

/** Removes every folder of an account. Returns how many were deleted. */
export async function deleteFoldersByOwner(ownerUserId: string): Promise<number> {
  const result = await folders().deleteMany({ ownerUserId });
  return result.deletedCount;
}
