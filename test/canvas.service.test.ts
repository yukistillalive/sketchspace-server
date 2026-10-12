import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// Same safety rule as socket.test.ts: only ever touch a database named "...-test".
const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri;

const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { createCanvas, findCanvas } = await import('../src/repositories/canvas.repository.js');
const { addStroke, listStrokes } = await import('../src/repositories/stroke.repository.js');
const { getJoinableCanvas, deleteCanvasWithStrokes } = await import('../src/services/canvas.service.js');

const stroke = (canvasId: string) => ({
  canvasId, layerId: 'foreground', brush: 'pen', size: 4, color: '#000000', opacity: 1,
  path: [{ x: 1, y: 2 }],
});

before(async () => {
  await connectDB();
  await getDb().dropDatabase();
});

after(async () => {
  await getDb().dropDatabase();
  await closeDB();
});

describe('getJoinableCanvas', () => {
  // Not a string, or not a 24-char hex id: rejected before any database lookup.
  it('rejects an invalid id', async () => {
    assert.deepEqual(await getJoinableCanvas('nope'), { ok: false, error: 'Invalid canvas id' });
    assert.deepEqual(await getJoinableCanvas(42), { ok: false, error: 'Invalid canvas id' });
  });

  // Well-formed id, no such canvas.
  it('rejects a canvas that does not exist', async () => {
    const res = await getJoinableCanvas('6abe45dcc09e70d0e46e4bbb');
    assert.deepEqual(res, { ok: false, error: 'Canvas not found' });
  });

  // Private canvases cannot be joined.
  it('rejects a canvas that is not shared', async () => {
    const id = await createCanvas({ name: 'private', isShared: false });
    assert.deepEqual(await getJoinableCanvas(id), { ok: false, error: 'Canvas is not shared' });
  });

  // Happy path: returns the canvas itself.
  it('accepts a shared canvas', async () => {
    const id = await createCanvas({ name: 'shared', isShared: true });
    const res = await getJoinableCanvas(id);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.canvas.name, 'shared');
  });
});

describe('deleteCanvasWithStrokes', () => {
  // Deleting a canvas also removes its strokes, and only its own strokes.
  it('removes the canvas and its strokes but not other canvases\' strokes', async () => {
    const doomed = await createCanvas({ name: 'doomed', isShared: true });
    const kept = await createCanvas({ name: 'kept', isShared: true });
    await addStroke(stroke(doomed));
    await addStroke(stroke(doomed));
    await addStroke(stroke(kept));

    assert.equal(await deleteCanvasWithStrokes(doomed), true);

    assert.equal(await findCanvas(doomed), null);
    assert.equal((await listStrokes(doomed)).length, 0);
    assert.equal((await listStrokes(kept)).length, 1);
  });

  // Unknown canvas: reports not found and deletes nothing.
  it('returns false for a canvas that does not exist', async () => {
    assert.equal(await deleteCanvasWithStrokes('6abe45dcc09e70d0e46e4bbb'), false);
  });
});
