// Everything a client sends for folders goes through here before it is used: clients are untrusted.

export const MAX_FOLDER_NAME = 30;

// a MongoDB ObjectId as a string
const FOLDER_ID_RE = /^[0-9a-f]{24}$/i;

export const isValidFolderId = (v: unknown): v is string => typeof v === 'string' && FOLDER_ID_RE.test(v);

/**
 * The name to store: trimmed, 1-30 characters (counted as Unicode code points, so an emoji is one).
 * Null if it is not a string or has the wrong length.
 */
export function parseFolderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= MAX_FOLDER_NAME ? name : null;
}

/** Body of PUT /api/canvas/:id/folder: `folderId` must be present, a folder id or null (= no folder). */
export function parseFolderMove(body: unknown): { folderId: string | null } | null {
  if (typeof body !== 'object' || body === null || !('folderId' in body)) return null;
  const { folderId } = body as Record<string, unknown>;
  if (folderId === null) return { folderId: null };
  return isValidFolderId(folderId) ? { folderId } : null;
}
