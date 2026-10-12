// Business rules shared by REST and socket entry points. Handlers call these instead of
// combining repository calls themselves, so a rule is written (and changed) in one place.
import {
  deleteCanvas,
  findCanvas,
  isValidCanvasId,
  type CanvasDoc,
} from '../repositories/canvas.repository.js';
import { deleteStrokesByCanvas } from '../repositories/stroke.repository.js';

export type JoinResult = { ok: true; canvas: CanvasDoc } | { ok: false; error: string };

/** A canvas can be joined if the id is valid, the canvas exists and it is shared. */
export async function getJoinableCanvas(id: unknown): Promise<JoinResult> {
  if (typeof id !== 'string' || !isValidCanvasId(id))
    return { ok: false, error: 'Invalid canvas id' };

  const canvas = await findCanvas(id);
  if (!canvas) return { ok: false, error: 'Canvas not found' };
  if (!canvas.isShared) return { ok: false, error: 'Canvas is not shared' };
  return { ok: true, canvas };
}

/** Deletes a canvas together with its strokes. Returns false if no canvas matched. */
export async function deleteCanvasWithStrokes(id: string): Promise<boolean> {
  const found = await deleteCanvas(id);
  if (found) await deleteStrokesByCanvas(id);
  return found;
}
