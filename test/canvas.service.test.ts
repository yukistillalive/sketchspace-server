import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// Same safety rule as socket.test.ts: only ever touch a database named "...-test".
const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri;

const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { createCanvas, findCanvas, toPublicCanvas } = await import('../src/repositories/canvas.repository.js');
const { addStroke, listStrokes } = await import('../src/repositories/stroke.repository.js');
const { canvasEvents } = await import('../src/services/canvas.events.js');
const {
  getAccessibleCanvas,
  listPublicCanvases,
  deleteCanvasWithStrokes,
  createCanvasWithOwner,
  updateCanvasAndNotify,
  clearCanvasStrokes,
} = await import('../src/services/canvas.service.js');
const { saveStroke, undoLastStroke, listStrokeMessages } = await import('../src/services/stroke.service.js');

const stroke = (canvasId: string) => ({
  canvasId, layerId: 'foreground', brush: 'pen', size: 4, color: '#000000', opacity: 1,
  path: [{ x: 1, y: 2 }],
});
const UNKNOWN_ID = '6abe45dcc09e70d0e46e4bbb';

/** Collects the arguments of a canvasEvents event until `stop()` is called. */
function record<K extends 'unshared' | 'deleted' | 'strokeAdded' | 'strokeRemoved' | 'cleared'>(event: K) {
  const seen: unknown[][] = [];
  const listener = (...args: unknown[]) => seen.push(args);
  canvasEvents.on(event, listener as never);
  return { seen, stop: () => canvasEvents.off(event, listener as never) };
}

before(async () => {
  await connectDB();
  await getDb().dropDatabase();
});

after(async () => {
  await getDb().dropDatabase();
  await closeDB();
});

describe('getAccessibleCanvas', () => {
  // Not a string, or not a 24-char hex id: rejected before any database lookup.
  it('rejects an invalid id (400)', async () => {
    assert.deepEqual(await getAccessibleCanvas('nope'), { ok: false, status: 400, error: 'Invalid canvas id' });
    assert.deepEqual(await getAccessibleCanvas(42), { ok: false, status: 400, error: 'Invalid canvas id' });
  });

  // Well-formed id, no such canvas.
  it('rejects a canvas that does not exist (404)', async () => {
    assert.deepEqual(await getAccessibleCanvas(UNKNOWN_ID), { ok: false, status: 404, error: 'Canvas not found' });
  });

  // Private canvases cannot be used without the owner token.
  it('rejects a private canvas without the owner token (403)', async () => {
    const id = await createCanvas({ name: 'private', isShared: false });
    assert.deepEqual(await getAccessibleCanvas(id), { ok: false, status: 403, error: 'Canvas is not shared' });
  });

  // Happy path: returns the canvas itself.
  it('accepts a shared canvas', async () => {
    const id = await createCanvas({ name: 'shared', isShared: true });
    const res = await getAccessibleCanvas(id);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.canvas.name, 'shared');
    assert.equal(res.ok && res.isOwner, false, 'no token, so not the owner');
  });

  // Solo mode: the owner token opens a private canvas; nothing else does.
  it('lets only the owner into a private canvas', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ isShared: false });
    const owner = await getAccessibleCanvas(canvasId, ownerToken);
    assert.equal(owner.ok && owner.isOwner, true);
    assert.equal((await getAccessibleCanvas(canvasId, 'wrong')).ok, false);
    assert.equal((await getAccessibleCanvas(canvasId, 42)).ok, false);
    assert.equal((await getAccessibleCanvas(canvasId)).ok, false);
  });

  // Canvases created before owners existed have no token: private ones stay closed to everyone.
  it('does not let anyone into an ownerless private canvas', async () => {
    const id = await createCanvas({ name: 'legacy', isShared: false });
    assert.equal((await getAccessibleCanvas(id, '')).ok, false);
    assert.equal((await getAccessibleCanvas(id, 'anything')).ok, false);
  });
});

describe('listPublicCanvases', () => {
  // Private canvases (and their ids) are not advertised, and no owner data is included.
  it('lists shared canvases only, without owner data', async () => {
    const shared = await createCanvasWithOwner({ name: 'listed', isShared: true });
    const hidden = await createCanvasWithOwner({ name: 'unlisted', isShared: false });
    const list = await listPublicCanvases();
    const ids = list.map((c) => c._id.toString());
    assert.ok(ids.includes(shared.canvasId));
    assert.equal(ids.includes(hidden.canvasId), false);
    assert.equal(JSON.stringify(list).includes('ownerTokenHash'), false);
  });
});

describe('createCanvasWithOwner', () => {
  // The secret is returned once; the database keeps only a hash of it.
  it('returns a token and stores only its hash', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'owned' });
    assert.match(ownerToken, /^[0-9a-f]{64}$/);
    const doc = await findCanvas(canvasId);
    assert.ok(doc?.ownerTokenHash);
    assert.notEqual(doc?.ownerTokenHash, ownerToken);
    assert.equal(JSON.stringify(doc).includes(ownerToken), false);
  });

  // Two canvases never share a token.
  it('issues a different token for each canvas', async () => {
    const a = await createCanvasWithOwner({});
    const b = await createCanvasWithOwner({});
    assert.notEqual(a.ownerToken, b.ownerToken);
  });

  // What clients receive (REST list/get) must not include the hash.
  it('hides the token hash from the public view', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'public' });
    const doc = await findCanvas(canvasId);
    assert.ok(doc && 'ownerTokenHash' in doc);
    assert.equal('ownerTokenHash' in toPublicCanvas(doc!), false);
  });
});

describe('updateCanvasAndNotify', () => {
  // Only the owner may change a canvas; the change is not applied otherwise.
  it('lets the owner update and refuses everyone else (403)', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'before', isShared: true });
    assert.deepEqual(await updateCanvasAndNotify(canvasId, { name: 'hacked' }), {
      ok: false, status: 403, error: 'Only the owner can change this canvas',
    });
    assert.equal((await updateCanvasAndNotify(canvasId, { name: 'hacked' }, 'wrong')).ok, false);
    assert.equal((await findCanvas(canvasId))?.name, 'before');

    assert.deepEqual(await updateCanvasAndNotify(canvasId, { name: 'after' }, ownerToken), { ok: true });
    assert.equal((await findCanvas(canvasId))?.name, 'after');
  });

  // Making a canvas private announces it so the socket layer can remove guests.
  it('announces "unshared" only when the owner makes a canvas private', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ isShared: true });
    const events = record('unshared');

    await updateCanvasAndNotify(canvasId, { name: 'renamed' }, ownerToken);
    await updateCanvasAndNotify(canvasId, { isShared: true }, ownerToken);
    await updateCanvasAndNotify(canvasId, { isShared: false }); // refused: no token
    assert.deepEqual(events.seen, []);

    await updateCanvasAndNotify(canvasId, { isShared: false }, ownerToken);
    assert.deepEqual(events.seen, [[canvasId]]);
    events.stop();
  });

  // Canvases created before owners existed are still manageable by anyone.
  it('leaves ownerless (legacy) canvases open', async () => {
    const id = await createCanvas({ name: 'legacy', isShared: true });
    assert.deepEqual(await updateCanvasAndNotify(id, { name: 'renamed' }), { ok: true });
  });

  // Unknown or malformed ids are reported, and nothing is announced.
  it('reports unknown (404) and invalid (400) ids', async () => {
    const events = record('unshared');
    assert.deepEqual(await updateCanvasAndNotify(UNKNOWN_ID, { isShared: false }), {
      ok: false, status: 404, error: 'Canvas not found',
    });
    const bad = await updateCanvasAndNotify('nope', { isShared: false });
    assert.equal(!bad.ok && bad.status, 400);
    assert.deepEqual(events.seen, []);
    events.stop();
  });
});

describe('deleteCanvasWithStrokes', () => {
  // Deleting a canvas also removes its strokes, and only its own strokes.
  it('removes the canvas and its strokes but not other canvases\' strokes', async () => {
    const doomed = await createCanvasWithOwner({ name: 'doomed', isShared: true });
    const kept = await createCanvasWithOwner({ name: 'kept', isShared: true });
    await addStroke(stroke(doomed.canvasId));
    await addStroke(stroke(doomed.canvasId));
    await addStroke(stroke(kept.canvasId));
    const events = record('deleted');

    assert.deepEqual(await deleteCanvasWithStrokes(doomed.canvasId, doomed.ownerToken), { ok: true });

    assert.equal(await findCanvas(doomed.canvasId), null);
    assert.equal((await listStrokes(doomed.canvasId)).length, 0);
    assert.equal((await listStrokes(kept.canvasId)).length, 1);
    assert.deepEqual(events.seen, [[doomed.canvasId]], 'participants are told');
    events.stop();
  });

  // Only the owner may delete; a refused attempt deletes nothing.
  it('refuses everyone but the owner (403) and deletes nothing', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    await addStroke(stroke(canvasId));
    const events = record('deleted');
    const res = await deleteCanvasWithStrokes(canvasId, 'wrong');
    assert.equal(!res.ok && res.status, 403);
    assert.ok(await findCanvas(canvasId));
    assert.equal((await listStrokes(canvasId)).length, 1);
    assert.deepEqual(events.seen, []);
    events.stop();
  });

  // Unknown canvas: reports not found and deletes nothing.
  it('returns 404 for a canvas that does not exist', async () => {
    const res = await deleteCanvasWithStrokes(UNKNOWN_ID);
    assert.equal(!res.ok && res.status, 404);
  });
});

describe('saveStroke', () => {
  // The one way to save a stroke: stored, then announced with the sender (so it is not echoed back).
  it('saves the stroke and announces it with its sender', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    const events = record('strokeAdded');
    const res = await saveStroke(stroke(canvasId), { socketId: 'socket-1', authorId: 'author-1' });
    assert.equal(res.ok, true);
    assert.equal((await listStrokes(canvasId)).length, 1);

    const [[message, sender]] = events.seen as [[{ id: string; canvasId: string }, string]];
    assert.equal(message.id, res.ok && res.id);
    assert.equal(message.canvasId, canvasId);
    assert.equal(sender, 'socket-1');
    assert.equal('createdAt' in message, false, 'wire shape has no createdAt');
    events.stop();
  });

  // A stroke for a canvas that was deleted (or never existed) is refused and not stored.
  it('refuses a canvas that does not exist or an invalid id', async () => {
    const events = record('strokeAdded');
    assert.deepEqual(await saveStroke(stroke(UNKNOWN_ID)), { ok: false, error: 'Canvas not found' });
    assert.deepEqual(await saveStroke(stroke('nope')), { ok: false, error: 'Invalid canvas id' });
    assert.equal((await listStrokes(UNKNOWN_ID)).length, 0);
    assert.deepEqual(events.seen, []);
    events.stop();
  });
});

describe('undoLastStroke', () => {
  const me = { socketId: 'socket-me', authorId: 'author-me' };
  const other = { socketId: 'socket-other', authorId: 'author-other' };

  // Undo removes the sender's latest stroke first, then the one before it, and tells the others.
  it('removes the sender\'s strokes newest first and announces each', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    const first = await saveStroke(stroke(canvasId), me);
    const second = await saveStroke(stroke(canvasId), me);
    const events = record('strokeRemoved');

    const undone = await undoLastStroke(canvasId, me);
    assert.deepEqual(undone, { ok: true, id: second.ok ? second.id : '' });
    assert.deepEqual(events.seen, [[canvasId, undone.ok ? undone.id : '', 'socket-me']]);
    assert.deepEqual((await listStrokeMessages(canvasId)).map((s) => s.id), [first.ok ? first.id : '']);

    assert.equal((await undoLastStroke(canvasId, me)).ok, true);
    assert.deepEqual(await undoLastStroke(canvasId, me), { ok: false, error: 'Nothing to undo' });
    events.stop();
  });

  // Undo never touches other people's strokes.
  it('only removes the sender\'s own strokes', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    await saveStroke(stroke(canvasId), me);
    const theirs = await saveStroke(stroke(canvasId), other); // drawn last
    await undoLastStroke(canvasId, me);
    assert.deepEqual((await listStrokeMessages(canvasId)).map((s) => s.id), [theirs.ok ? theirs.id : '']);
  });

  // Strokes saved over REST have no author, so nobody can undo them.
  it('cannot undo strokes that were saved without a sender', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    await saveStroke(stroke(canvasId));
    assert.deepEqual(await undoLastStroke(canvasId, me), { ok: false, error: 'Nothing to undo' });
    assert.equal((await listStrokeMessages(canvasId)).length, 1);
  });

  // The author is stored server-side but never leaves it.
  it('keeps the author out of what clients receive', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    await saveStroke(stroke(canvasId), me);
    assert.equal(JSON.stringify(await listStrokeMessages(canvasId)).includes('author'), false);
  });

  // Undo is scoped to one canvas.
  it('does not undo strokes in another canvas', async () => {
    const a = await createCanvasWithOwner({ isShared: true });
    const b = await createCanvasWithOwner({ isShared: true });
    await saveStroke(stroke(a.canvasId), me);
    assert.deepEqual(await undoLastStroke(b.canvasId, me), { ok: false, error: 'Nothing to undo' });
    assert.equal((await listStrokeMessages(a.canvasId)).length, 1);
  });
});

describe('clearCanvasStrokes', () => {
  // The owner clears every stroke of the canvas, not those of other canvases, and others are told.
  it('removes all strokes of the canvas for the owner and announces it', async () => {
    const mine = await createCanvasWithOwner({ isShared: true });
    const other = await createCanvasWithOwner({ isShared: true });
    await saveStroke(stroke(mine.canvasId));
    await saveStroke(stroke(mine.canvasId), { socketId: 's', authorId: 'a' });
    await saveStroke(stroke(other.canvasId));
    const events = record('cleared');

    assert.deepEqual(await clearCanvasStrokes(mine.canvasId, { ownerToken: mine.ownerToken }, 'socket-x'), {
      ok: true, removed: 2,
    });
    assert.equal((await listStrokeMessages(mine.canvasId)).length, 0);
    assert.equal((await listStrokeMessages(other.canvasId)).length, 1);
    assert.deepEqual(events.seen, [[mine.canvasId, 'socket-x']]);
    events.stop();
  });

  // A socket that already proved ownership at join can clear without the token.
  it('accepts a verified owner without a token', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    await saveStroke(stroke(canvasId));
    assert.deepEqual(await clearCanvasStrokes(canvasId, { verifiedOwner: true }), { ok: true, removed: 1 });
  });

  // Anyone else is refused and nothing is removed or announced.
  it('refuses everyone but the owner (403)', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    await saveStroke(stroke(canvasId));
    const events = record('cleared');
    for (const auth of [{}, { ownerToken: 'wrong' }, { verifiedOwner: false }]) {
      const res = await clearCanvasStrokes(canvasId, auth);
      assert.equal(!res.ok && res.status, 403);
    }
    assert.equal((await listStrokeMessages(canvasId)).length, 1);
    assert.deepEqual(events.seen, []);
    events.stop();
  });

  // Unknown or malformed ids are reported.
  it('reports unknown (404) and invalid (400) ids', async () => {
    const unknown = await clearCanvasStrokes(UNKNOWN_ID, { verifiedOwner: true });
    assert.equal(!unknown.ok && unknown.status, 404);
    const bad = await clearCanvasStrokes('nope', { verifiedOwner: true });
    assert.equal(!bad.ok && bad.status, 400);
  });
});
