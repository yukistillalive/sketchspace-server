// Folder rules: an account organises its own canvases into folders. Only the owner can see or
// change a folder, and a canvas can be in at most one folder (its `folderId`).
import { findCanvas, removeFolderFromCanvases, setCanvasFolder } from '../repositories/canvas.repository.js';
import {
  createFolder as insertFolder,
  deleteFolder as removeFolder,
  deleteFoldersByOwner,
  findFolder,
  listFoldersByOwner,
  renameFolder as changeFolderName,
} from '../repositories/folder.repository.js';
import { toPublicFolder, type FolderDoc, type PublicFolder } from '../models/folder.model.js';
import { isDuplicateKeyError } from '../repositories/errors.js';
import { isValidCanvasId } from '../validation/canvas.validation.js';
import { isValidFolderId, MAX_FOLDER_NAME, parseFolderName } from '../validation/folder.validation.js';

/** Why a request was refused. `status` is the matching HTTP status for REST handlers. */
export type FolderFailure = { ok: false; status: 400 | 403 | 404 | 409; error: string };

const INVALID_NAME: FolderFailure = {
  ok: false,
  status: 400,
  error: `Folder name must be 1-${MAX_FOLDER_NAME} characters`,
};
const DUPLICATE_NAME: FolderFailure = { ok: false, status: 409, error: 'A folder with this name already exists' };
const NOT_FOUND: FolderFailure = { ok: false, status: 404, error: 'Folder not found' };

/** Checks the id, that the folder exists and that it belongs to `userId`. */
async function getOwnedFolder(id: unknown, userId: string): Promise<{ ok: true; folder: FolderDoc } | FolderFailure> {
  if (!isValidFolderId(id)) return { ok: false, status: 400, error: 'Invalid folder id' };
  const folder = await findFolder(id);
  if (!folder) return NOT_FOUND;
  if (folder.ownerUserId !== userId) return { ok: false, status: 403, error: 'Not your folder' };
  return { ok: true, folder };
}

/** The account's folders, oldest first. */
export async function listFoldersOf(userId: string): Promise<PublicFolder[]> {
  return (await listFoldersByOwner(userId)).map(toPublicFolder);
}

/** Creates a folder. The name is trimmed; it must be 1-30 characters and not taken (ignoring case). */
export async function createFolder(
  userId: string,
  rawName: unknown,
): Promise<{ ok: true; folder: PublicFolder } | FolderFailure> {
  const name = parseFolderName(rawName);
  if (name === null) return INVALID_NAME;

  try {
    return { ok: true, folder: toPublicFolder(await insertFolder(userId, name)) };
  } catch (err) {
    if (isDuplicateKeyError(err)) return DUPLICATE_NAME;
    throw err;
  }
}

/** Renames one of the account's folders, with the same name rules as createFolder. */
export async function renameFolder(
  id: unknown,
  userId: string,
  rawName: unknown,
): Promise<{ ok: true; folder: PublicFolder } | FolderFailure> {
  const owned = await getOwnedFolder(id, userId);
  if (!owned.ok) return owned;
  const name = parseFolderName(rawName);
  if (name === null) return INVALID_NAME;

  try {
    const renamed = await changeFolderName(owned.folder._id.toString(), name);
    return renamed ? { ok: true, folder: toPublicFolder(renamed) } : NOT_FOUND;
  } catch (err) {
    if (isDuplicateKeyError(err)) return DUPLICATE_NAME;
    throw err;
  }
}

/** Deletes one of the account's folders. Its canvases are kept and end up in no folder. */
export async function deleteFolder(id: unknown, userId: string): Promise<{ ok: true } | FolderFailure> {
  const owned = await getOwnedFolder(id, userId);
  if (!owned.ok) return owned;

  const folderId = owned.folder._id.toString();
  if (!(await removeFolder(folderId))) return NOT_FOUND;
  // after the delete, so a canvas moved in just before is taken out too
  await removeFolderFromCanvases(folderId);
  return { ok: true };
}

/**
 * Moves a canvas into a folder, or out of any folder (`folderId` null). Both must belong to the
 * account: the canvas through its login owner (a token-only canvas must be claimed first).
 */
export async function moveCanvasToFolder(
  canvasId: unknown,
  folderId: string | null,
  userId: string,
): Promise<{ ok: true } | FolderFailure> {
  if (typeof canvasId !== 'string' || !isValidCanvasId(canvasId))
    return { ok: false, status: 400, error: 'Invalid canvas id' };
  const canvas = await findCanvas(canvasId);
  if (!canvas) return { ok: false, status: 404, error: 'Canvas not found' };
  if (canvas.ownerUserId !== userId) return { ok: false, status: 403, error: 'Only the owner can move this canvas' };

  if (folderId !== null) {
    const owned = await getOwnedFolder(folderId, userId);
    if (!owned.ok) return owned;
  }

  if (!(await setCanvasFolder(canvasId, folderId))) return { ok: false, status: 404, error: 'Canvas not found' };
  return { ok: true };
}

/** Deletes every folder of an account (used when the account is deleted). */
export function deleteFoldersOfUser(userId: string): Promise<number> {
  return deleteFoldersByOwner(userId);
}
