import { Router } from 'express';
import { authUserId, requireAuth } from '../middleware/auth.middleware.js';
import { createFolder, deleteFolder, listFoldersOf, renameFolder } from '../services/folder.service.js';

export const folderRouter = Router();

folderRouter.use(requireAuth);

/** The `name` field of a JSON body; the service checks it. */
const nameOf = (body: unknown): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>).name : undefined);

// GET /api/folders (the logged-in user's folders, oldest first)
folderRouter.get('/', async (_req, res) => {
  res.json(await listFoldersOf(authUserId(res)));
});

// POST /api/folders  { name }
folderRouter.post('/', async (req, res) => {
  const result = await createFolder(authUserId(res), nameOf(req.body));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.folder);
});

// PUT /api/folders/:id  { name }
folderRouter.put('/:id', async (req, res) => {
  const result = await renameFolder(req.params.id, authUserId(res), nameOf(req.body));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.folder);
});

// DELETE /api/folders/:id (its canvases are kept and end up in no folder)
folderRouter.delete('/:id', async (req, res) => {
  const result = await deleteFolder(req.params.id, authUserId(res));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});
