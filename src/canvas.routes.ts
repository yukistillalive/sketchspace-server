import { Router } from 'express';
import * as repo from './canvas.repository.js';

export const canvasRouter = Router();

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

  const canvasId = await repo.createCanvas(body);
  res.status(201).json({ canvasId });
});

// read all
canvasRouter.get('/', async (_req, res) => {
  res.json(await repo.listCanvas());
});

// read one
canvasRouter.get('/:id', async (req, res) => {
  if (!repo.isValidCanvasId(req.params.id))
    return res.status(400).json({ error: 'Invalid canvas id' });

  const canvas = await repo.findCanvas(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'Canvas not found' });
  res.json(canvas);
});

// update (partial: name and/or isShared)
canvasRouter.put('/:id', async (req, res) => {
  if (!repo.isValidCanvasId(req.params.id))
    return res.status(400).json({ error: 'Invalid canvas id' });

  const body = parseBody(req.body);
  if (!body || (body.name === undefined && body.isShared === undefined))
    return res.status(400).json({ error: 'Provide name (string) and/or isShared (boolean)' });

  const found = await repo.updateCanvas(req.params.id, body);
  if (!found) return res.status(404).json({ error: 'Canvas not found' });
  res.json({ ok: true });
});

// delete
canvasRouter.delete('/:id', async (req, res) => { //when a delete request arrives at /:id, run this to send a response
  if (!repo.isValidCanvasId(req.params.id)) //checks format
    return res.status(400).json({ error: 'Invalid canvas id' });

  const found = await repo.deleteCanvas(req.params.id); //found holds the result (true/false) of a calling async function
  if (!found) return res.status(404).json({ error: 'Canvas not found' });
  res.json({ ok: true });
});
