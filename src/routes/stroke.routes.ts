import { Router } from 'express';
import { isValidCanvasId, findCanvas } from '../repositories/canvas.repository.js';
import { addStroke, listStrokes } from '../repositories/stroke.repository.js';
import { parseStroke } from '../validation/stroke.validation.js';

export const strokeRouter = Router();

// POST /api/canvas/:id/strokes
strokeRouter.post('/:id/strokes', async (req, res) => {
  if (!isValidCanvasId(req.params.id))
    return res.status(400).json({ error: 'Invalid canvas id' });

  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const stroke = parseStroke({ ...body, canvasId: req.params.id }); // id comes from the URL
  if (!stroke) return res.status(400).json({ error: 'Invalid stroke fields' });

  const canvas = await findCanvas(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'Canvas not found' });

  const strokeId = await addStroke(stroke);
  res.status(201).json({ strokeId });
});

// GET /api/canvas/:id/strokes
strokeRouter.get('/:id/strokes', async (req, res) => {
  if (!isValidCanvasId(req.params.id))
    return res.status(400).json({ error: 'Invalid canvas id' });

  const canvas = await findCanvas(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'Canvas not found' });

  res.json(await listStrokes(req.params.id));
});
