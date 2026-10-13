import { Router, type Request } from 'express';
import * as repo from '../repositories/canvas.repository.js';
import {
  createCanvasWithOwner,
  deleteCanvasWithStrokes,
  getAccessibleCanvas,
  listPublicCanvases,
  updateCanvasAndNotify,
} from '../services/canvas.service.js';

export const canvasRouter = Router();

/** The owner token the client proves ownership with (returned once by POST /api/canvas). */
export const ownerTokenOf = (req: Request): string | undefined => req.header('x-owner-token');

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
  const { canvasId, ownerToken } = await createCanvasWithOwner(body);
  res.status(201).json({ canvasId, ownerToken });
});

// read all (shared canvases only)
canvasRouter.get('/', async (_req, res) => {
  res.json(await listPublicCanvases());
});

// read one (a private canvas needs the owner token)
canvasRouter.get('/:id', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  res.json(repo.toPublicCanvas(access.canvas));
});

// update (partial: name and/or isShared; owner only)
canvasRouter.put('/:id', async (req, res) => {
  const body = parseBody(req.body);
  if (!body || (body.name === undefined && body.isShared === undefined))
    return res.status(400).json({ error: 'Provide name (string) and/or isShared (boolean)' });

  const result = await updateCanvasAndNotify(req.params.id, body, ownerTokenOf(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// delete (owner only; also removes its strokes)
canvasRouter.delete('/:id', async (req, res) => {
  const result = await deleteCanvasWithStrokes(req.params.id, ownerTokenOf(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});
