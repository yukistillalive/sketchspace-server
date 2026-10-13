import { Router } from 'express';
import { clearCanvasStrokes, getAccessibleCanvas } from '../services/canvas.service.js';
import { deleteStrokeById, listStrokeMessages, saveStroke } from '../services/stroke.service.js';
import { parseStroke } from '../validation/stroke.validation.js';
import { ownerTokenOf } from './canvas.routes.js';

export const strokeRouter = Router();

// POST /api/canvas/:id/strokes (a private canvas needs the owner token)
strokeRouter.post('/:id/strokes', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const stroke = parseStroke({ ...body, canvasId: req.params.id }); // id comes from the URL
  if (!stroke) return res.status(400).json({ error: 'Invalid stroke fields' });

  const saved = await saveStroke(stroke); // also pushes it to people connected to the canvas
  if (!saved.ok) return res.status(404).json({ error: saved.error });
  res.status(201).json({ strokeId: saved.id });
});

// GET /api/canvas/:id/strokes (a private canvas needs the owner token)
strokeRouter.get('/:id/strokes', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  res.json(await listStrokeMessages(req.params.id));
});

// DELETE /api/canvas/:id/strokes (clear the canvas; owner only)
strokeRouter.delete('/:id/strokes', async (req, res) => {
  const result = await clearCanvasStrokes(req.params.id, { ownerToken: ownerTokenOf(req) });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, removed: result.removed });
});

// DELETE /api/canvas/:id/strokes/:strokeId (a private canvas needs the owner token)
strokeRouter.delete('/:id/strokes/:strokeId', async (req, res) => {
  const access = await getAccessibleCanvas(req.params.id, ownerTokenOf(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const result = await deleteStrokeById(req.params.id, req.params.strokeId);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});
