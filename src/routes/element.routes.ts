import { Router } from 'express';
import { getAccessibleCanvas } from '../services/canvas.service.js';
import { addElement, deleteElement, listElementMessages, updateElement } from '../services/element.service.js';
import { parseElement, parseElementUpdate } from '../validation/element.validation.js';
import { ownerTokenOf } from './canvas.routes.js';

export const elementRouter = Router();

// GET /api/canvas/:id/elements (a private canvas needs the owner token)
elementRouter.get('/:id/elements', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  res.json(await listElementMessages(req.params.id));
});

// POST /api/canvas/:id/elements (a private canvas needs the owner token)
elementRouter.post('/:id/elements', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const element = parseElement({ ...body, canvasId: req.params.id }); // id comes from the URL
  if (!element) return res.status(400).json({ error: 'Invalid element fields' });

  const saved = await addElement(element); // also pushes it to people connected to the canvas
  if (!saved.ok) return res.status(saved.status).json({ error: saved.error });
  res.status(201).json({ elementId: saved.id });
});

// PUT /api/canvas/:id/elements/:elementId (partial update; last write wins)
elementRouter.put('/:id/elements/:elementId', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const changes = parseElementUpdate(req.body);
  if (!changes) return res.status(400).json({ error: 'Invalid element fields' });

  const result = await updateElement(req.params.id, req.params.elementId, changes);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// DELETE /api/canvas/:id/elements/:elementId
elementRouter.delete('/:id/elements/:elementId', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const result = await deleteElement(req.params.id, req.params.elementId);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});
