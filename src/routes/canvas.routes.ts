import { Router } from 'express';
import {
  claimCanvas,
  createCanvasWithOwner,
  deleteCanvasWithStrokes,
  getAccessibleCanvasView,
  listCanvasesOf,
  listPublicCanvases,
  updateCanvasAndNotify,
} from '../services/canvas.service.js';
import { moveCanvasToFolder } from '../services/folder.service.js';
import { authUserId, ownerTokenOf, requireAuth, userIdOf } from '../middleware/auth.middleware.js';
import { parseCanvasBody } from '../validation/canvas.validation.js';
import { parseFolderMove } from '../validation/folder.validation.js';

export const canvasRouter = Router();

// create
canvasRouter.post('/', async (req, res) => {
  const body = parseCanvasBody(req.body);
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
  const result = await getAccessibleCanvasView(req.params.id, ownerTokenOf(req), userIdOf(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.canvas);
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

// update (partial: name, isShared (joinable by id) and/or isPublic (listed in the Gallery); owner only)
canvasRouter.put('/:id', async (req, res) => {
  const body = parseCanvasBody(req.body);
  if (!body || (body.name === undefined && body.isShared === undefined && body.isPublic === undefined))
    return res.status(400).json({ error: 'Provide name (string), isShared (boolean) and/or isPublic (boolean)' });

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
