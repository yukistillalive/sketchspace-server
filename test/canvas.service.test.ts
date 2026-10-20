import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

// Same safety rule as socket.test.ts: only ever touch a database named "...-test".
const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri;

const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { createCanvas, findCanvas } = await import('../src/repositories/canvas.repository.js');
const { toPublicCanvas } = await import('../src/models/canvas.model.js');
const { addStroke, listStrokes } = await import('../src/repositories/stroke.repository.js');
const { addElement: insertElement, listElements } = await import('../src/repositories/element.repository.js');
const { parseElement, parseElementUpdate } = await import('../src/validation/element.validation.js');
const { addElement, updateElement, deleteElement, listElementMessages } = await import('../src/services/element.service.js');
const { canvasEvents } = await import('../src/services/canvas.events.js');
const {
  getAccessibleCanvas,
  listPublicCanvases,
  deleteCanvasWithStrokes,
  createCanvasWithOwner,
  updateCanvasAndNotify,
  clearCanvasStrokes,
} = await import('../src/services/canvas.service.js');
const { saveStroke, undoLastStroke, listStrokeMessages, deleteStrokeById } = await import('../src/services/stroke.service.js');

const stroke = (canvasId: string) => ({
  canvasId, layerId: 'foreground', brush: 'pen', size: 4, color: '#000000', opacity: 1,
  path: [{ x: 1, y: 2 }],
});
const shape = (canvasId: string, over: object = {}) => ({
  canvasId, type: 'shape' as const, x: 10, y: 20, width: 100, height: 50, rotation: 0, zIndex: 1,
  shape: 'circle', color: '#ff0000', ...over,
});
const cutout = (canvasId: string, over: object = {}) => ({
  canvasId, type: 'cutout', x: 0, y: 0, width: 200, height: 100, rotation: 15, zIndex: 2,
  shape: 'circle', url: 'https://images.unsplash.com/photo-1', photographer: 'Ann', photographerLink: 'https://unsplash.com/@ann',
  cutWidth: 80, cutHeight: 60, photo: { x: -5, y: 5, width: 300, height: 200, rotation: 0 }, ...over,
});
const UNKNOWN_ID = '6abe45dcc09e70d0e46e4bbb';

/** Collects the arguments of a canvasEvents event until `stop()` is called. */
function record<K extends 'unshared' | 'deleted' | 'strokeAdded' | 'strokeRemoved' | 'strokeDeleted' | 'cleared' | 'elementAdded' | 'elementUpdated' | 'elementDeleted'>(event: K) {
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
  it('lists public canvases only, without owner data', async () => {
    const listed = await createCanvasWithOwner({ name: 'listed', isPublic: true });
    const byId = await createCanvasWithOwner({ name: 'by-id', isShared: true });
    const hidden = await createCanvasWithOwner({ name: 'unlisted', isShared: false });
    const list = await listPublicCanvases();
    const ids = list.map((c) => c._id.toString());
    assert.ok(ids.includes(listed.canvasId));
    assert.equal(ids.includes(byId.canvasId), false); // shared by id, not in the Gallery
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

  // Sharing by id and being listed in the Gallery are separate; public needs shared.
  it('keeps sharing and the Gallery separate', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({});
    const gallery = async () => (await listPublicCanvases()).some((c) => c._id.toString() === canvasId);

    await updateCanvasAndNotify(canvasId, { isShared: true }, ownerToken);
    assert.equal((await findCanvas(canvasId))?.isShared, true);
    assert.equal(await gallery(), false); // joinable by id, not listed

    await updateCanvasAndNotify(canvasId, { isPublic: true }, ownerToken);
    assert.equal(await gallery(), true);

    await updateCanvasAndNotify(canvasId, { isPublic: false }, ownerToken);
    assert.equal((await findCanvas(canvasId))?.isShared, true); // still shared by id
    assert.equal(await gallery(), false);

    // making it public shares it; making it private unlists it
    await updateCanvasAndNotify(canvasId, { isShared: false }, ownerToken);
    await updateCanvasAndNotify(canvasId, { isPublic: true }, ownerToken);
    assert.equal((await findCanvas(canvasId))?.isShared, true);
    await updateCanvasAndNotify(canvasId, { isShared: false }, ownerToken);
    assert.equal(await gallery(), false);

    const conflict = await updateCanvasAndNotify(canvasId, { isShared: false, isPublic: true }, ownerToken);
    assert.equal(conflict.ok, false);
  });

  // Canvases created before isPublic existed are listed when shared, and stay that way.
  it('lists older shared canvases that have no isPublic', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ isShared: true });
    await getDb().collection('canvas').updateOne({ _id: new ObjectId(canvasId) }, { $unset: { isPublic: '' } });
    assert.ok((await listPublicCanvases()).some((c) => c._id.toString() === canvasId));
    await updateCanvasAndNotify(canvasId, { isShared: true }, ownerToken);
    assert.ok((await listPublicCanvases()).some((c) => c._id.toString() === canvasId));
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

describe('deleteStrokeById', () => {
  // Removes exactly one stroke of that canvas and tells the others.
  it('removes one stroke and announces it with its sender', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    const a = await saveStroke(stroke(canvasId));
    const b = await saveStroke(stroke(canvasId));
    const id = a.ok ? a.id : '';
    const events = record('strokeDeleted');

    assert.deepEqual(await deleteStrokeById(canvasId, id, 'socket-1'), { ok: true });
    assert.deepEqual((await listStrokeMessages(canvasId)).map((s) => s.id), [b.ok ? b.id : '']);
    assert.deepEqual(events.seen, [[canvasId, id, 'socket-1']]);
    events.stop();
  });

  // A stroke of another canvas cannot be deleted through this one.
  it('reports unknown strokes (404), other canvases\' strokes (404) and invalid ids (400)', async () => {
    const mine = await createCanvasWithOwner({ isShared: true });
    const other = await createCanvasWithOwner({ isShared: true });
    const theirs = await saveStroke(stroke(other.canvasId));
    const theirId = theirs.ok ? theirs.id : '';
    const events = record('strokeDeleted');

    assert.equal((await deleteStrokeById(mine.canvasId, UNKNOWN_ID) as { status: number }).status, 404);
    assert.equal((await deleteStrokeById(mine.canvasId, theirId) as { status: number }).status, 404);
    assert.equal((await deleteStrokeById(UNKNOWN_ID, theirId) as { status: number }).status, 404);
    assert.equal((await deleteStrokeById(mine.canvasId, 'nope') as { status: number }).status, 400);
    assert.equal((await deleteStrokeById('nope', theirId) as { status: number }).status, 400);
    assert.equal((await listStrokeMessages(other.canvasId)).length, 1);
    assert.deepEqual(events.seen, []);
    events.stop();
  });
});

describe('element validation', () => {
  const id = UNKNOWN_ID;

  // Each type needs its own fields; extra fields are dropped.
  it('accepts valid shapes, photos and cutouts and drops unknown fields', () => {
    assert.ok(parseElement(shape(id)));
    assert.ok(parseElement(shape(id, { color: null })), 'null color = dashed template');
    assert.ok(parseElement(shape(id, { color: undefined })));
    assert.ok(parseElement({ ...shape(id), type: 'photo', url: 'https://images.unsplash.com/x', shape: undefined, color: undefined }));
    assert.ok(parseElement(cutout(id)));
    assert.equal(parseElement(cutout(id))!.shape, 'circle', 'cutouts keep their shape');
    const parsed = parseElement(shape(id, { evil: 1, ownerTokenHash: 'x', url: 'https://a.b' }));
    assert.deepEqual(Object.keys(parsed!).sort(), ['canvasId', 'color', 'height', 'rotation', 'shape', 'type', 'width', 'x', 'y', 'zIndex']);
  });

  it('rejects bad types, numbers, sizes, shapes, urls and missing type fields', () => {
    const bad: unknown[] = [
      null, 'hello', {},
      shape(id, { type: 'sticker' }),
      shape(id, { x: NaN }), shape(id, { x: Infinity }), shape(id, { x: '1' }), shape(id, { x: 1e9 }),
      shape(id, { width: 0 }), shape(id, { height: -1 }), shape(id, { width: 1e6 }),
      shape(id, { rotation: 1e9 }), shape(id, { zIndex: undefined }),
      shape(id, { shape: 'blob' }), shape(id, { shape: undefined }),
      shape(id, { color: 5 }), shape(id, { color: 'x'.repeat(65) }),
      shape(id, { canvasId: '' }),
      cutout(id, { url: 'javascript:alert(1)' }), cutout(id, { url: 'http://insecure.example' }),
      cutout(id, { url: 'https://a.b/' + 'x'.repeat(2100) }), cutout(id, { url: undefined }), cutout(id, { shape: undefined }), cutout(id, { shape: 'blob' }),
      cutout(id, { photographer: 'x'.repeat(201) }), cutout(id, { photographerLink: 'not a url' }),
      cutout(id, { cutWidth: 0 }), cutout(id, { cutHeight: undefined }),
      cutout(id, { photo: undefined }), cutout(id, { photo: { x: 0, y: 0, width: 0, height: 5, rotation: 0 } }),
    ];
    for (const payload of bad) assert.equal(parseElement(payload), null, `should reject ${JSON.stringify(payload)?.slice(0, 80)}`);
  });

  it('accepts partial updates and rejects empty or invalid ones', () => {
    assert.deepEqual(parseElementUpdate({ x: 5 }), { x: 5 });
    assert.deepEqual(parseElementUpdate({ color: null }), { color: null });
    assert.deepEqual(parseElementUpdate({ x: 1, canvasId: 'other', type: 'photo', junk: 1 }), { x: 1 }, 'canvas and type are not editable');
    assert.deepEqual(parseElementUpdate({ photo: { x: 1, y: 2, width: 3, height: 4, rotation: 5, junk: 6 } }), {
      photo: { x: 1, y: 2, width: 3, height: 4, rotation: 5 },
    });
    for (const bad of [null, 'x', {}, { junk: 1 }, { x: NaN }, { width: 0 }, { shape: 'blob' }, { url: 'ftp://x.y' }, { x: 1, y: 'a' }])
      assert.equal(parseElementUpdate(bad), null, `should reject ${JSON.stringify(bad)}`);
  });
});

describe('element service', () => {
  const ok = async (canvasId: string, over: object = {}) => {
    const res = await addElement(parseElement(shape(canvasId, over))!);
    assert.equal(res.ok, true);
    return res.ok ? res.id : '';
  };

  // Stored, then announced with the sender (so it is not echoed back); wire shape has id and no _id.
  it('adds an element and announces it with its sender', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    const events = record('elementAdded');
    const res = await addElement(parseElement(shape(canvasId))!, 'socket-1');
    assert.equal(res.ok, true);
    assert.equal((await listElements(canvasId)).length, 1);

    const [[message, sender]] = events.seen as [[Record<string, unknown>, string]];
    assert.equal(message.id, res.ok && res.id);
    assert.equal(message.canvasId, canvasId);
    assert.equal(sender, 'socket-1');
    assert.equal('_id' in message, false);
    assert.ok(message.createdAt instanceof Date && message.updatedAt instanceof Date);
    events.stop();
  });

  it('refuses a canvas that does not exist or an invalid id, and stores nothing', async () => {
    const events = record('elementAdded');
    assert.deepEqual(await addElement(parseElement(shape(UNKNOWN_ID))!), { ok: false, status: 404, error: 'Canvas not found' });
    assert.deepEqual(await addElement(parseElement(shape('nope'))!), { ok: false, status: 400, error: 'Invalid canvas id' });
    assert.equal((await listElements(UNKNOWN_ID)).length, 0);
    assert.deepEqual(events.seen, []);
    events.stop();
  });

  // Oldest first, scoped to the canvas.
  it('lists a canvas\'s elements oldest first and only its own', async () => {
    const a = await createCanvasWithOwner({ isShared: true });
    const b = await createCanvasWithOwner({ isShared: true });
    const first = await ok(a.canvasId);
    const second = await ok(a.canvasId, { type: 'shape', shape: 'star' });
    await ok(b.canvasId);
    assert.deepEqual((await listElementMessages(a.canvasId)).map((e) => e.id), [first, second]);
  });

  // Partial change, server sets updatedAt, last write wins, the new state is announced.
  it('updates only the given fields, bumps updatedAt and announces the new state', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    const id = await ok(canvasId);
    const before = (await listElementMessages(canvasId))[0]!;
    const events = record('elementUpdated');
    await new Promise((r) => setTimeout(r, 5));

    assert.deepEqual(await updateElement(canvasId, id, { x: 99, color: null }, 'socket-1'), { ok: true });
    assert.deepEqual(await updateElement(canvasId, id, { x: 100 }, 'socket-2'), { ok: true }); // last write wins
    const after = (await listElementMessages(canvasId))[0]!;
    assert.equal(after.x, 100);
    assert.equal(after.color, null);
    assert.equal(after.width, before.width, 'untouched fields stay');
    assert.ok(after.updatedAt > before.updatedAt);
    assert.deepEqual(after.createdAt, before.createdAt);

    const [[first, sender1], [second, sender2]] = events.seen as [[{ id: string; x: number }, string], [{ x: number }, string]];
    assert.deepEqual([first.id, first.x, sender1, second.x, sender2], [id, 99, 'socket-1', 100, 'socket-2']);
    events.stop();
  });

  it('reports unknown elements (404), other canvases\' elements (404) and invalid ids (400)', async () => {
    const mine = await createCanvasWithOwner({ isShared: true });
    const other = await createCanvasWithOwner({ isShared: true });
    const theirs = await ok(other.canvasId);
    const events = record('elementUpdated');
    const status = (r: { ok: boolean }) => (r.ok ? 200 : (r as unknown as { status: number }).status);

    assert.equal(status(await updateElement(mine.canvasId, UNKNOWN_ID, { x: 1 })), 404);
    assert.equal(status(await updateElement(mine.canvasId, theirs, { x: 1 })), 404);
    assert.equal(status(await updateElement(UNKNOWN_ID, theirs, { x: 1 })), 404);
    assert.equal(status(await updateElement(mine.canvasId, 'nope', { x: 1 })), 400);
    assert.equal(status(await updateElement('nope', theirs, { x: 1 })), 400);
    assert.equal((await listElementMessages(other.canvasId))[0]!.x, 10, 'nothing changed');
    assert.deepEqual(events.seen, []);
    events.stop();
  });

  it('deletes one element, announces it, and reports unknown or foreign ones', async () => {
    const mine = await createCanvasWithOwner({ isShared: true });
    const other = await createCanvasWithOwner({ isShared: true });
    const keep = await ok(mine.canvasId);
    const doomed = await ok(mine.canvasId);
    const theirs = await ok(other.canvasId);
    const events = record('elementDeleted');

    assert.deepEqual(await deleteElement(mine.canvasId, doomed, 'socket-1'), { ok: true });
    assert.deepEqual((await listElementMessages(mine.canvasId)).map((e) => e.id), [keep]);
    assert.deepEqual(events.seen, [[mine.canvasId, doomed, 'socket-1']]);

    assert.equal((await deleteElement(mine.canvasId, doomed) as { status: number }).status, 404, 'already gone');
    assert.equal((await deleteElement(mine.canvasId, theirs) as { status: number }).status, 404);
    assert.equal((await deleteElement(mine.canvasId, 'nope') as { status: number }).status, 400);
    assert.equal((await listElementMessages(other.canvasId)).length, 1);
    assert.equal(events.seen.length, 1);
    events.stop();
  });

  // The access rule lives in getAccessibleCanvas (shared = anyone, private = owner); routes and
  // sockets both call it before any element operation.
  it('relies on the same access rules as strokes: private canvases need the owner token', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ isShared: false });
    assert.equal((await getAccessibleCanvas(canvasId)).ok, false);
    assert.equal((await getAccessibleCanvas(canvasId, 'wrong')).ok, false);
    assert.equal((await getAccessibleCanvas(canvasId, ownerToken)).ok, true);
  });
});

describe('deleteCanvasWithStrokes and elements', () => {
  // Deleting a canvas also removes its elements, and only its own.
  it('removes the canvas\'s elements but not other canvases\' elements', async () => {
    const doomed = await createCanvasWithOwner({ isShared: true });
    const kept = await createCanvasWithOwner({ isShared: true });
    await insertElement(parseElement(shape(doomed.canvasId))!);
    await insertElement(parseElement(cutout(doomed.canvasId))!);
    await insertElement(parseElement(shape(kept.canvasId))!);

    assert.deepEqual(await deleteCanvasWithStrokes(doomed.canvasId, doomed.ownerToken), { ok: true });
    assert.equal((await listElements(doomed.canvasId)).length, 0);
    assert.equal((await listElements(kept.canvasId)).length, 1);
  });

  it('keeps the elements when a non-owner tries to delete the canvas', async () => {
    const { canvasId } = await createCanvasWithOwner({ isShared: true });
    await insertElement(parseElement(shape(canvasId))!);
    assert.equal((await deleteCanvasWithStrokes(canvasId, 'wrong')).ok, false);
    assert.equal((await listElements(canvasId)).length, 1);
  });
});
