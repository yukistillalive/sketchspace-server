// Business rules shared by REST and socket entry points. Handlers call these instead of
// combining repository calls themselves, so a rule is written (and changed) in one place.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createCanvas,
  deleteCanvas,
  findCanvas,
  isValidCanvasId,
  listSharedCanvas,
  toPublicCanvas,
  updateCanvas,
  type CanvasDoc,
  type CanvasUpdate,
  type NewCanvas,
  type PublicCanvas,
} from '../repositories/canvas.repository.js';
import { deleteStrokesByCanvas } from '../repositories/stroke.repository.js';
import { canvasEvents } from './canvas.events.js';

/** Why a request was refused. `status` is the matching HTTP status for REST handlers. */
export type Failure = { ok: false; status: 400 | 403 | 404; error: string };

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** True if `token` is the owner token this canvas was created with. */
export function isOwner(canvas: CanvasDoc, token: unknown): boolean {
  if (typeof token !== 'string' || !canvas.ownerTokenHash) return false;
  const given = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(canvas.ownerTokenHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** Creates a canvas and returns its id plus the secret owner token (only the hash is stored). */
export async function createCanvasWithOwner(
  input: NewCanvas,
): Promise<{ canvasId: string; ownerToken: string }> {
  const ownerToken = randomBytes(32).toString('hex');
  const canvasId = await createCanvas(input, hashToken(ownerToken));
  return { canvasId, ownerToken };
}

export type AccessResult = { ok: true; canvas: CanvasDoc; isOwner: boolean } | Failure;

/**
 * Who can use a canvas (join it, read it, read or add strokes):
 *  - a shared canvas: anyone (the owner is recognised by the token)
 *  - a private canvas: only its owner (solo mode)
 */
export async function getAccessibleCanvas(id: unknown, ownerToken?: unknown): Promise<AccessResult> {
  if (typeof id !== 'string' || !isValidCanvasId(id))
    return { ok: false, status: 400, error: 'Invalid canvas id' };

  const canvas = await findCanvas(id);
  if (!canvas) return { ok: false, status: 404, error: 'Canvas not found' };

  const owner = isOwner(canvas, ownerToken);
  if (!canvas.isShared && !owner) return { ok: false, status: 403, error: 'Canvas is not shared' };
  return { ok: true, canvas, isOwner: owner };
}

/** Canvases visible to everyone: the shared ones. Private canvases are not listed. */
export async function listPublicCanvases(): Promise<PublicCanvas[]> {
  return (await listSharedCanvas()).map(toPublicCanvas);
}

/**
 * Only the owner may rename, share/unshare or delete a canvas. Canvases created before owner
 * tokens existed have no owner and stay open to everyone.
 */
async function getManageableCanvas(id: string, ownerToken?: unknown): Promise<AccessResult> {
  if (!isValidCanvasId(id)) return { ok: false, status: 400, error: 'Invalid canvas id' };
  const canvas = await findCanvas(id);
  if (!canvas) return { ok: false, status: 404, error: 'Canvas not found' };

  const owner = isOwner(canvas, ownerToken);
  if (canvas.ownerTokenHash && !owner)
    return { ok: false, status: 403, error: 'Only the owner can change this canvas' };
  return { ok: true, canvas, isOwner: owner };
}

/** Updates a canvas (owner only). Making it private removes the other participants. */
export async function updateCanvasAndNotify(
  id: string,
  changes: CanvasUpdate,
  ownerToken?: unknown,
): Promise<{ ok: true } | Failure> {
  const allowed = await getManageableCanvas(id, ownerToken);
  if (!allowed.ok) return allowed;

  if (!(await updateCanvas(id, changes))) return { ok: false, status: 404, error: 'Canvas not found' };
  if (changes.isShared === false) canvasEvents.emit('unshared', id);
  return { ok: true };
}

/** Deletes a canvas together with its strokes (owner only) and removes everyone from it. */
export async function deleteCanvasWithStrokes(
  id: string,
  ownerToken?: unknown,
): Promise<{ ok: true } | Failure> {
  const allowed = await getManageableCanvas(id, ownerToken);
  if (!allowed.ok) return allowed;

  if (!(await deleteCanvas(id))) return { ok: false, status: 404, error: 'Canvas not found' };
  await deleteStrokesByCanvas(id);
  canvasEvents.emit('deleted', id);
  return { ok: true };
}
