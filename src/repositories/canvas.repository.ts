import { ObjectId, type Collection } from 'mongodb';
import { getDb } from '../db.js';
import {
  DEFAULT_LAYERS,
  type Canvas,
  type CanvasDoc,
  type CanvasUpdate,
  type NewCanvas,
} from '../models/canvas.model.js';

const canvas = (): Collection<Canvas> => getDb().collection<Canvas>('canvas');

export async function createCanvas(
  { name, isShared }: NewCanvas,
  ownerTokenHash?: string,
  ownerUserId?: string,
): Promise<string> {
  const now = new Date();
  const result = await canvas().insertOne({
    name: name ?? 'untitled',
    isShared: isShared ?? false,
    createdAt: now,
    updatedAt: now,
    layers: DEFAULT_LAYERS,
    ...(ownerTokenHash && { ownerTokenHash }),
    ...(ownerUserId && { ownerUserId }),
  });
  return result.insertedId.toString();
}

export function listCanvas(): Promise<CanvasDoc[]> {
  return canvas().find().toArray();
}

export function listSharedCanvas(): Promise<CanvasDoc[]> {
  return canvas().find({ isShared: true }).toArray();
}

/** The canvases an account owns (shared and private), most recently changed first. */
export function listCanvasByOwner(userId: string): Promise<CanvasDoc[]> {
  return canvas().find({ ownerUserId: userId }).sort({ updatedAt: -1 }).toArray();
}

/** Attaches a canvas to an account. Returns false if no canvas matched. */
export async function setCanvasOwnerUser(id: string, userId: string): Promise<boolean> {
  const result = await canvas().updateOne({ _id: new ObjectId(id) }, { $set: { ownerUserId: userId } });
  return result.matchedCount > 0;
}

/** Puts a canvas in a folder, or in no folder (null). Returns false if no canvas matched. */
export async function setCanvasFolder(id: string, folderId: string | null): Promise<boolean> {
  const result = await canvas().updateOne(
    { _id: new ObjectId(id) },
    folderId === null ? { $unset: { folderId: '' } } : { $set: { folderId } },
  );
  return result.matchedCount > 0;
}

/** Takes every canvas out of a folder (the canvases stay). Returns how many were changed. */
export async function removeFolderFromCanvases(folderId: string): Promise<number> {
  const result = await canvas().updateMany({ folderId }, { $unset: { folderId: '' } });
  return result.modifiedCount;
}

export function findCanvas(id: string): Promise<CanvasDoc | null> {
  return canvas().findOne({ _id: new ObjectId(id) });
}

/** Applies only the fields that are present. Returns false if no canvas matched. */
export async function updateCanvas(id: string, changes: CanvasUpdate): Promise<boolean> {
  const set: Partial<Canvas> = { updatedAt: new Date() };
  if (changes.name !== undefined) set.name = changes.name;
  if (changes.isShared !== undefined) set.isShared = changes.isShared;

  const result = await canvas().updateOne({ _id: new ObjectId(id) }, { $set: set });
  return result.matchedCount > 0;
}

/** Returns false if no canvas matched. */
export async function deleteCanvas(id: string): Promise<boolean> {
  const result = await canvas().deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount > 0;
}
