import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from '../db.js';

export interface Layer {
  id: string;
  order: number;
  visible: boolean;
}

export interface Canvas {
  name: string;
  /** A shared canvas can be joined by other users; an unshared one is private. */
  isShared: boolean;
  createdAt: Date;
  updatedAt: Date;
  layers: Layer[];
  /** SHA-256 of the owner token. Absent on canvases created before owners existed. Never sent to clients. */
  ownerTokenHash?: string;
  /** The account that created the canvas while logged in. Never sent to clients. */
  ownerUserId?: string;
  /** The owner's folder the canvas is in; absent = in no folder. Only sent to the owner. */
  folderId?: string;
}

//the layer at the forefront starts with 0, layers behind it will be numbered > 0. (order 1 is behind order 0)
const defaultLayers: Layer[] = [{id: "foreground", order: 0, visible: true}, 
{id: "middleground", order: 1, visible: true}, {id: "background", order: 2, visible: true}
]

export type CanvasDoc = WithId<Canvas>;
/**
 * A canvas as sent to clients: everything except the owner token hash, the owner account and the
 * folder (folders are private to the owner).
 */
export type PublicCanvas = Omit<CanvasDoc, 'ownerTokenHash' | 'ownerUserId' | 'folderId'>;

export function toPublicCanvas({
  ownerTokenHash: _hash,
  ownerUserId: _user,
  folderId: _folder,
  ...rest
}: CanvasDoc): PublicCanvas {
  return rest;
}

/** A canvas as sent to its owner: the public view plus its folder (null = in no folder). */
export type OwnedCanvas = PublicCanvas & { folderId: string | null };

export const toOwnedCanvas = (doc: CanvasDoc): OwnedCanvas => ({ ...toPublicCanvas(doc), folderId: doc.folderId ?? null });

export interface NewCanvas {
  name?: string;
  isShared?: boolean;
}

export type CanvasUpdate = NewCanvas;

const canvas = (): Collection<Canvas> => getDb().collection<Canvas>('canvas');

export const isValidCanvasId = (id: string): boolean => /^[0-9a-f]{24}$/i.test(id);

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
    layers: defaultLayers,
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
