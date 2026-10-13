// Stroke rules shared by REST and sockets: one way to save a stroke (and tell the canvas about
// it) and one wire shape for strokes.
import { findCanvas, isValidCanvasId } from '../repositories/canvas.repository.js';
import {
  addStroke,
  deleteLastStrokeByAuthor,
  deleteStroke,
  listStrokes,
  type NewStroke,
  type Stroke,
  type StrokeDoc,
} from '../repositories/stroke.repository.js';
import { canvasEvents } from './canvas.events.js';

/** A stroke as clients see it, over REST and sockets alike: its fields plus `id` (no createdAt). */
export type StrokeMessage = Omit<Stroke, 'createdAt' | 'authorId'> & { id: string };

export function toStrokeMessage({ _id, createdAt: _createdAt, authorId: _authorId, ...rest }: StrokeDoc): StrokeMessage {
  return { ...rest, id: _id.toString() };
}

/** All strokes of a canvas in drawing order (oldest first). */
export async function listStrokeMessages(canvasId: string): Promise<StrokeMessage[]> {
  return (await listStrokes(canvasId)).map(toStrokeMessage);
}

export type SaveStrokeResult = { ok: true; id: string } | { ok: false; error: string };

/** The socket a request came from and who it counts as: used for undo and to skip echoing. */
export interface Sender {
  socketId: string;
  authorId: string;
}

/**
 * Saves a stroke, then pushes it to everyone in the canvas except the sender (who already drew
 * it). Used by both the socket handler and the REST endpoint, so a stroke posted over REST
 * reaches live participants too. The canvas must still exist.
 */
export async function saveStroke(
  stroke: Omit<NewStroke, 'authorId'>,
  sender?: Sender,
): Promise<SaveStrokeResult> {
  if (!isValidCanvasId(stroke.canvasId)) return { ok: false, error: 'Invalid canvas id' };
  if (!(await findCanvas(stroke.canvasId))) return { ok: false, error: 'Canvas not found' };

  // save first, so anything others see is already stored
  const id = await addStroke(sender ? { ...stroke, authorId: sender.authorId } : stroke);
  canvasEvents.emit('strokeAdded', { ...stroke, id }, sender?.socketId);
  return { ok: true, id };
}

export type UndoResult = { ok: true; id: string } | { ok: false; error: string };

/** Removes the sender's most recent stroke in a canvas and tells the others. */
export async function undoLastStroke(canvasId: string, sender: Sender): Promise<UndoResult> {
  if (!isValidCanvasId(canvasId)) return { ok: false, error: 'Invalid canvas id' };
  const removed = await deleteLastStrokeByAuthor(canvasId, sender.authorId);
  if (!removed) return { ok: false, error: 'Nothing to undo' };

  const id = removed._id.toString();
  canvasEvents.emit('strokeRemoved', canvasId, id, sender.socketId);
  return { ok: true, id };
}

export type DeleteStrokeResult = { ok: true } | { ok: false; status: 400 | 404; error: string };

/** Removes one stroke by id and tells the others (except the socket that asked, if any). */
export async function deleteStrokeById(
  canvasId: string,
  strokeId: string,
  senderSocketId?: string,
): Promise<DeleteStrokeResult> {
  if (!isValidCanvasId(canvasId)) return { ok: false, status: 400, error: 'Invalid canvas id' };
  if (!isValidCanvasId(strokeId)) return { ok: false, status: 400, error: 'Invalid stroke id' }; // same id format
  if (!(await findCanvas(canvasId))) return { ok: false, status: 404, error: 'Canvas not found' };
  if (!(await deleteStroke(canvasId, strokeId))) return { ok: false, status: 404, error: 'Stroke not found' };

  canvasEvents.emit('strokeDeleted', canvasId, strokeId, senderSocketId);
  return { ok: true };
}
