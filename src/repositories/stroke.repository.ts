import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from '../db.js';

export interface Path {
  x: number;
  y: number;
}

export interface Stroke {
  canvasId: string;
  layerId: string;
  path: Path[];
  brush: string;
  size: number;
  color: string;
  opacity: number;
  createdAt: Date;
  /** Who drew it: 'owner' or a socket id. Server-side only, never sent to clients. Absent for REST strokes. */
  authorId?: string;
}

export type StrokeDoc = WithId<Stroke>;
export type NewStroke = Omit<Stroke, 'createdAt'>;

const strokes = (): Collection<Stroke> => getDb().collection<Stroke>('strokes');

export async function addStroke(stroke: NewStroke): Promise<string> {
  const result = await strokes().insertOne({ ...stroke, createdAt: new Date() });
  return result.insertedId.toString();
}

/** All strokes of a canvas in drawing order (oldest first). */
export function listStrokes(canvasId: string): Promise<StrokeDoc[]> {
  return strokes().find({ canvasId }).sort({ createdAt: 1 }).toArray();
}

/** Removes every stroke of a canvas. Returns how many were deleted. */
export async function deleteStrokesByCanvas(canvasId: string): Promise<number> {
  const result = await strokes().deleteMany({ canvasId });
  return result.deletedCount;
}

/** Removes and returns the most recent stroke drawn by `authorId` in a canvas, or null if none. */
export function deleteLastStrokeByAuthor(canvasId: string, authorId: string): Promise<StrokeDoc | null> {
  return strokes().findOneAndDelete({ canvasId, authorId }, { sort: { createdAt: -1, _id: -1 } });
}

/** Removes one stroke of a canvas by id. Returns false if no such stroke exists in the canvas. */
export async function deleteStroke(canvasId: string, strokeId: string): Promise<boolean> {
  const result = await strokes().deleteOne({ _id: new ObjectId(strokeId), canvasId });
  return result.deletedCount > 0;
}
