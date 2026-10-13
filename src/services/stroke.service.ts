// Stroke rules shared by REST and sockets: one way to save a stroke (and tell the canvas about
// it) and one wire shape for strokes.
import { findCanvas, isValidCanvasId } from '../repositories/canvas.repository.js';
import {
  addStroke,
  listStrokes,
  type NewStroke,
  type Stroke,
  type StrokeDoc,
} from '../repositories/stroke.repository.js';
import { canvasEvents } from './canvas.events.js';

/** A stroke as clients see it, over REST and sockets alike: its fields plus `id` (no createdAt). */
export type StrokeMessage = Omit<Stroke, 'createdAt'> & { id: string };

export function toStrokeMessage({ _id, createdAt: _createdAt, ...rest }: StrokeDoc): StrokeMessage {
  return { ...rest, id: _id.toString() };
}

/** All strokes of a canvas in drawing order (oldest first). */
export async function listStrokeMessages(canvasId: string): Promise<StrokeMessage[]> {
  return (await listStrokes(canvasId)).map(toStrokeMessage);
}

export type SaveStrokeResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Saves a stroke, then pushes it to everyone in the canvas except `senderSocketId` (the sender
 * already drew it). Used by both the socket handler and the REST endpoint, so a stroke posted
 * over REST reaches live participants too. The canvas must still exist.
 */
export async function saveStroke(stroke: NewStroke, senderSocketId?: string): Promise<SaveStrokeResult> {
  if (!isValidCanvasId(stroke.canvasId)) return { ok: false, error: 'Invalid canvas id' };
  if (!(await findCanvas(stroke.canvasId))) return { ok: false, error: 'Canvas not found' };

  const id = await addStroke(stroke); // save first, so anything others see is already stored
  canvasEvents.emit('strokeAdded', { ...stroke, id }, senderSocketId);
  return { ok: true, id };
}
