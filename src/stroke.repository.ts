import { type Collection, type WithId } from 'mongodb';
import { getDb } from './db.js';

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
