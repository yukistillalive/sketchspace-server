// Business rules shared by REST and socket entry points. Handlers call these instead of
// combining repository calls themselves, so a rule is written (and changed) in one place.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createCanvas,
  deleteCanvas,
  findCanvas,
  listCanvasByOwner,
  listSharedCanvas,
  setCanvasOwnerUser,
  updateCanvas,
} from '../repositories/canvas.repository.js';
import {
  toOwnedCanvas,
  toPublicCanvas,
  type CanvasDoc,
  type CanvasUpdate,
  type NewCanvas,
  type OwnedCanvas,
  type PublicCanvas,
} from '../models/canvas.model.js';
import { isValidCanvasId } from '../validation/canvas.validation.js';
import { deleteElementsByCanvas } from '../repositories/element.repository.js';
import { deleteStrokesByCanvas } from '../repositories/stroke.repository.js';
import { canvasEvents } from './canvas.events.js';

/** Why a request was refused. `status` is the matching HTTP status for REST handlers. */
export type Failure = { ok: false; status: 400 | 403 | 404; error: string };

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * True if the requester owns the canvas: the logged-in user is the account it belongs to, or
 * `token` is the owner token it was created with.
 */
export function isOwner(canvas: CanvasDoc, token: unknown, userId?: string | null): boolean {
  if (userId && canvas.ownerUserId === userId) return true;
  if (typeof token !== 'string' || !canvas.ownerTokenHash) return false;
  const given = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(canvas.ownerTokenHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/**
 * Creates a canvas and returns its id plus the secret owner token (only the hash is stored).
 * A logged-in creator (`userId`) also becomes the owner as an account, so the canvas stays theirs
 * on any device.
 */
export async function createCanvasWithOwner(
  input: NewCanvas,
  userId?: string | null,
): Promise<{ canvasId: string; ownerToken: string }> {
  const ownerToken = randomBytes(32).toString('hex');
  const canvasId = await createCanvas(input, hashToken(ownerToken), userId ?? undefined);
  return { canvasId, ownerToken };
}

export type AccessResult = { ok: true; canvas: CanvasDoc; isOwner: boolean } | Failure;

/**
 * Who can use a canvas (join it, read it, read or add strokes):
 *  - a shared canvas: anyone (the owner is recognised by the token or the login)
 *  - a private canvas: only its owner (solo mode)
 */
export async function getAccessibleCanvas(
  id: unknown,
  ownerToken?: unknown,
  userId?: string | null,
): Promise<AccessResult> {
  if (typeof id !== 'string' || !isValidCanvasId(id))
    return { ok: false, status: 400, error: 'Invalid canvas id' };

  const canvas = await findCanvas(id);
  if (!canvas) return { ok: false, status: 404, error: 'Canvas not found' };

  const owner = isOwner(canvas, ownerToken, userId);
  if (!canvas.isShared && !owner) return { ok: false, status: 403, error: 'Canvas is not shared' };
  return { ok: true, canvas, isOwner: owner };
}

/** The canvas as a client sees it (no owner secrets) plus whether the caller owns it, or why it is refused. */
export async function getAccessibleCanvasView(
  id: unknown,
  ownerToken?: unknown,
  userId?: string | null,
): Promise<{ ok: true; canvas: PublicCanvas & { isOwner: boolean } } | Failure> {
  const access = await getAccessibleCanvas(id, ownerToken, userId);
  if (!access.ok) return access;
  return { ok: true, canvas: { ...toPublicCanvas(access.canvas), isOwner: access.isOwner } };
}

/** Canvases visible to everyone: the shared ones. Private canvases are not listed. */
export async function listPublicCanvases(): Promise<PublicCanvas[]> {
  return (await listSharedCanvas()).map(toPublicCanvas);
}

/**
 * Only the owner may rename, share/unshare or delete a canvas. Canvases created before owner
 * tokens existed have no owner and stay open to everyone.
 */
async function getManageableCanvas(
  id: string,
  ownerToken?: unknown,
  verifiedOwner = false,
  userId?: string | null,
): Promise<AccessResult> {
  if (!isValidCanvasId(id)) return { ok: false, status: 400, error: 'Invalid canvas id' };
  const canvas = await findCanvas(id);
  if (!canvas) return { ok: false, status: 404, error: 'Canvas not found' };

  const owner = verifiedOwner || isOwner(canvas, ownerToken, userId);
  if ((canvas.ownerTokenHash || canvas.ownerUserId) && !owner)
    return { ok: false, status: 403, error: 'Only the owner can change this canvas' };
  return { ok: true, canvas, isOwner: owner };
}

/** Updates a canvas (owner only). Making it private removes the other participants. */
export async function updateCanvasAndNotify(
  id: string,
  changes: CanvasUpdate,
  ownerToken?: unknown,
  userId?: string | null,
): Promise<{ ok: true } | Failure> {
  const allowed = await getManageableCanvas(id, ownerToken, false, userId);
  if (!allowed.ok) return allowed;

  if (!(await updateCanvas(id, changes))) return { ok: false, status: 404, error: 'Canvas not found' };
  if (changes.isShared === false) canvasEvents.emit('unshared', id);
  return { ok: true };
}

/** Deletes a canvas together with its strokes and elements (owner only) and removes everyone from it. */
export async function deleteCanvasWithStrokes(
  id: string,
  ownerToken?: unknown,
  userId?: string | null,
): Promise<{ ok: true } | Failure> {
  const allowed = await getManageableCanvas(id, ownerToken, false, userId);
  if (!allowed.ok) return allowed;

  if (!(await deleteCanvas(id))) return { ok: false, status: 404, error: 'Canvas not found' };
  await deleteStrokesByCanvas(id);
  await deleteElementsByCanvas(id);
  canvasEvents.emit('deleted', id);
  return { ok: true };
}

/**
 * Removes every stroke of a canvas (owner only) and tells the other participants. A socket that
 * already proved ownership when it joined passes `verifiedOwner` instead of the token.
 */
export async function clearCanvasStrokes(
  id: string,
  auth: { ownerToken?: unknown; verifiedOwner?: boolean; userId?: string | null },
  senderSocketId?: string,
): Promise<{ ok: true; removed: number } | Failure> {
  const allowed = await getManageableCanvas(id, auth.ownerToken, auth.verifiedOwner, auth.userId);
  if (!allowed.ok) return allowed;

  const removed = await deleteStrokesByCanvas(id);
  canvasEvents.emit('cleared', id, senderSocketId);
  return { ok: true, removed };
}

/** The canvases an account owns, shared and private, each with its `folderId` (null = in no folder). */
export async function listCanvasesOf(userId: string): Promise<OwnedCanvas[]> {
  return (await listCanvasByOwner(userId)).map(toOwnedCanvas);
}

/**
 * Attaches a canvas that was created with an owner token (before logging in, or before accounts
 * existed) to an account. The owner token proves it is theirs; a canvas that already belongs to
 * another account is refused.
 */
export async function claimCanvas(
  id: string,
  ownerToken: unknown,
  userId: string,
): Promise<{ ok: true } | Failure> {
  if (!isValidCanvasId(id)) return { ok: false, status: 400, error: 'Invalid canvas id' };
  const canvas = await findCanvas(id);
  if (!canvas) return { ok: false, status: 404, error: 'Canvas not found' };
  if (canvas.ownerUserId === userId) return { ok: true };
  if (canvas.ownerUserId || !isOwner(canvas, ownerToken))
    return { ok: false, status: 403, error: 'Only the owner can claim this canvas' };

  await setCanvasOwnerUser(id, userId);
  return { ok: true };
}

/** Deletes every canvas an account owns, with its strokes and elements, and removes everyone from them. */
export async function deleteCanvasesOfUser(userId: string): Promise<number> {
  const owned = await listCanvasByOwner(userId);
  for (const { _id } of owned) {
    const id = _id.toString();
    await deleteCanvas(id);
    await deleteStrokesByCanvas(id);
    await deleteElementsByCanvas(id);
    canvasEvents.emit('deleted', id);
  }
  return owned.length;
}
