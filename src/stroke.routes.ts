import { Router } from 'express';
import { isValidCanvasId, findCanvas } from './canvas.repository.js';
import { addStroke, listStrokes, type NewStroke, type Path } from './stroke.repository.js';

export const strokeRouter = Router();

/** Picks and type-checks the stroke body fields; returns null if any is the wrong type. */
function parseBody(body: unknown): Omit<NewStroke, 'canvasId'> | null {
  const { layerId, path, brush, size, color, opacity } = (body ?? {}) as Record<string, unknown>;

  if (typeof layerId !== 'string') return null;
  if (typeof brush !== 'string') return null;
  if (typeof size !== 'number') return null;
  if (typeof color !== 'string') return null;
  if (typeof opacity !== 'number') return null;
  if (
    !Array.isArray(path) ||
    !path.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Record<string, unknown>).x === 'number' &&
        typeof (p as Record<string, unknown>).y === 'number',
    )
  )
    return null;

  return { layerId, path: path as Path[], brush, size, color, opacity };
}

// POST /api/canvas/:id/strokes
strokeRouter.post('/:id/strokes', async (req, res) => {
  if (!isValidCanvasId(req.params.id))
    return res.status(400).json({ error: 'Invalid canvas id' });

  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ error: 'Invalid stroke fields' });

  const canvas = await findCanvas(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'Canvas not found' });

  const strokeId = await addStroke({ canvasId: req.params.id, ...body });
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
