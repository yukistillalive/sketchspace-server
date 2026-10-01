import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from './db.js';

export interface Canvas {
  name: string;
  /** A shared canvas can be joined by other users; an unshared one is private. */
  isShared: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CanvasDoc = WithId<Canvas>;

export interface NewCanvas {
  name?: string;
  isShared?: boolean;
}

export type CanvasUpdate = NewCanvas;

const canvas = (): Collection<Canvas> => getDb().collection<Canvas>('canvas');

export const isValidCanvasId = (id: string): boolean => ObjectId.isValid(id);

export async function createCanvas({ name, isShared }: NewCanvas): Promise<string> {
  const now = new Date();
  const result = await canvas().insertOne({
    name: name ?? 'untitled',
    isShared: isShared ?? false,
    createdAt: now,
    updatedAt: now,
  });
  return result.insertedId.toString();
}

export function listCanvas(): Promise<CanvasDoc[]> {
  return canvas().find().toArray();
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
