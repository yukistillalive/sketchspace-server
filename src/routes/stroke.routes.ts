import { Router } from 'express';
import { getAccessibleCanvas } from '../services/canvas.service.js';
import { listStrokeMessages, saveStroke } from '../services/stroke.service.js';
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
