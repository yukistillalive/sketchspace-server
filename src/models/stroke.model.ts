import type { WithId } from 'mongodb';

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
