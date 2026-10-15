import { Router, type Request } from 'express';
import * as repo from '../repositories/canvas.repository.js';
import {
  claimCanvas,
  createCanvasWithOwner,
  deleteCanvasWithStrokes,
  getAccessibleCanvas,
  listCanvasesOf,
  listPublicCanvases,
  updateCanvasAndNotify,
} from '../services/canvas.service.js';
import { moveCanvasToFolder } from '../services/folder.service.js';
import { authUserId, optionalUserId, requireAuth } from '../middleware/auth.middleware.js';
import { parseFolderMove } from '../validation/folder.validation.js';

export const canvasRouter = Router();

/** The owner token the client proves ownership with (returned once by POST /api/canvas). */
export const ownerTokenOf = (req: Request): string | undefined => req.header('x-owner-token');

/** The logged-in user's id for canvas rules, undefined for a guest. */
export const userIdOf = (req: Request): string | undefined => optionalUserId(req) ?? undefined;

/** Picks and type-checks the writable fields; returns null if any is the wrong type. */
function parseBody(body: unknown): repo.CanvasUpdate | null {
  const { name, isShared } = (body ?? {}) as Record<string, unknown>;
  if (name !== undefined && typeof name !== 'string') return null;
  if (isShared !== undefined && typeof isShared !== 'boolean') return null;
  return { name, isShared };
}

// create
canvasRouter.post('/', async (req, res) => {
  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ error: 'Invalid canvas fields' });

  // ownerToken is shown once, here. Keep it: it proves ownership for everything private.
  // A logged-in creator also owns the canvas as an account, on any device.
  const { canvasId, ownerToken } = await createCanvasWithOwner(body, userIdOf(req));
  res.status(201).json({ canvasId, ownerToken });
});

// read all (shared canvases only)
canvasRouter.get('/', async (_req, res) => {
  res.json(await listPublicCanvases());
});

// read the logged-in user's canvases, shared and private (must come before /:id)
canvasRouter.get('/mine', requireAuth, async (_req, res) => {
  res.json(await listCanvasesOf(authUserId(res)));
});

// read one (a private canvas needs the owner token or the owner's login); isOwner tells whether the caller owns it
canvasRouter.get('/:id', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req), userIdOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  res.json({ ...repo.toPublicCanvas(access.canvas), isOwner: access.isOwner });
});

// claim: attach a canvas made with an owner token to the logged-in account (the token proves it is theirs)
canvasRouter.post('/:id/claim', requireAuth, async (req, res) => {
  const result = await claimCanvas(String(req.params.id), ownerTokenOf(req), authUserId(res));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// move into one of the user's folders, or out of any folder with null (logged-in owner only)
canvasRouter.put('/:id/folder', requireAuth, async (req, res) => {
  const body = parseFolderMove(req.body);
  if (!body) return res.status(400).json({ error: 'Provide folderId (folder id or null)' });

  const result = await moveCanvasToFolder(req.params.id, body.folderId, authUserId(res));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// update (partial: name and/or isShared; owner only)
canvasRouter.put('/:id', async (req, res) => {
  const body = parseBody(req.body);
  if (!body || (body.name === undefined && body.isShared === undefined))
    return res.status(400).json({ error: 'Provide name (string) and/or isShared (boolean)' });

  const result = await updateCanvasAndNotify(req.params.id, body, ownerTokenOf(req), userIdOf(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// delete (owner only; also removes its strokes)
canvasRouter.delete('/:id', async (req, res) => {
  const result = await deleteCanvasWithStrokes(req.params.id, ownerTokenOf(req), userIdOf(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});
