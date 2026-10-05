import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from './db.js';

export interface Path{
    x: number;
    y: number;
}

export interface Stroke{
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

const strokes = (): Collection<Stroke> => getDb().collection<Stroke>('strokes');

   export type NewStroke = Omit<Stroke, 'createdAt'>;

export async function addStroke({ canvasId, layerId, path, brush, size, color, opacity }: NewStroke): Promise<string> {
  const now = new Date();
  const result = await strokes().insertOne({
    canvasId: canvasId,
    layerId: layerId,
    path: path,
    brush: brush,
    size: size,
    color: color,
    opacity: opacity,
    createdAt: now,
  });
  return result.insertedId.toString();
}