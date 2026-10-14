import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';

// the data in MONGODB_URI. Set TEST_MONGODB_URI to use another test database.
const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri; // db.ts reads this when first imported
process.env.JWT_SECRET ??= 'test-secret'; // the socket reads the login cookie, so it loads the auth code

// Imported after the env var is set (static imports would run first).
const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { registerCanvasSocket } = await import('../src/socket/canvas.socket.js');
const { createCanvas } = await import('../src/repositories/canvas.repository.js');
const { listStrokes } = await import('../src/repositories/stroke.repository.js');
const { createCanvasWithOwner, updateCanvasAndNotify, deleteCanvasWithStrokes } = await import('../src/services/canvas.service.js');
const { saveStroke, deleteStrokeById } = await import('../src/services/stroke.service.js');
const { addElement } = await import('../src/services/element.service.js');
const { listElements } = await import('../src/repositories/element.repository.js');
const { parseElement } = await import('../src/validation/element.validation.js');

const WAIT_MS = 2000; // max wait for an event that should arrive
const QUIET_MS = 150; // how long to wait to prove an event does not arrive

let httpServer: HttpServer;
let url: string;
let sharedId: string;
let privateId: string;
const sockets: Socket[] = [];

const client = (): Promise<Socket> =>
  new Promise((resolve) => {
    const s = connect(url, { forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
  });

/** emit with an ack and resolve with the ack payload */
const call = (s: Socket, event: string, ...args: unknown[]): Promise<any> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for ${event}`)), WAIT_MS);
    s.emit(event, ...args, (res: unknown) => {
      clearTimeout(t);
      resolve(res);
    });
  });

/** resolve with the payload of the next `event`, or reject on timeout */
const next = (s: Socket, event: string): Promise<any> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event} received`)), WAIT_MS);
    s.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });

/** true if `event` arrives within QUIET_MS */
const arrives = (s: Socket, event: string): Promise<boolean> =>
  new Promise((resolve) => {
    const onEvent = () => resolve(true);
    s.once(event, onEvent);
    setTimeout(() => {
      s.off(event, onEvent);
      resolve(false);
    }, QUIET_MS);
  });

const stroke = (canvasId: string, over: object = {}) => ({
  canvasId,
  layerId: 'foreground',
  brush: 'pen',
  size: 4,
  color: '#000000',
  opacity: 1,
  path: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
  ...over,
});

const element = (canvasId: string, over: object = {}) => ({
  canvasId, type: 'shape', x: 10, y: 20, width: 100, height: 50, rotation: 0, zIndex: 1,
  shape: 'circle', color: '#ff0000', ...over,
});

before(async () => {
  await connectDB();
  await getDb().dropDatabase(); // start clean
  httpServer = createServer();
  registerCanvasSocket(new Server(httpServer));
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as { port: number }).port}`;

  sharedId = await createCanvas({ name: 'shared', isShared: true });
  privateId = await createCanvas({ name: 'private', isShared: false });
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await getDb().dropDatabase();
  await closeDB();
  httpServer.close();
});

// Joining a canvas
describe('canvas:join', () => {
  // A malformed canvas id is refused
  it('rejects an invalid id', async () => {
    const s = await client();
    const res = await call(s, 'canvas:join', 'nope');
    assert.equal(res.ok, false);
  });

  // A well-formed id with no matching canvas gets a "not found" error.
  it('rejects a canvas that does not exist', async () => {
    const s = await client();
    const res = await call(s, 'canvas:join', '6abe45dcc09e70d0e46e4bbb');
    assert.equal(res.ok, false);
    assert.match(res.error, /not found/i);
  });

  // Private canvases (isShared: false) cannot be joined.
  it('rejects a canvas that is not shared', async () => {
    const s = await client();
    const res = await call(s, 'canvas:join', privateId);
    assert.equal(res.ok, false);
    assert.match(res.error, /not shared/i);
  });

  // a shared canvas can be joined and the ack carries its strokes.
  it('accepts a shared canvas and returns its saved strokes', async () => {
    const s = await client();
    const res = await call(s, 'canvas:join', sharedId);
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.strokes));
    assert.ok(Array.isArray(res.elements));
  });
});

// Drawing: strokes are validated, saved, and relayed to the right people only.
describe('stroke:add', () => {
  // Drawing without joining first is refused.
  it('is rejected before joining a canvas', async () => {
    const s = await client();
    const res = await call(s, 'stroke:add', stroke(sharedId));
    assert.equal(res.ok, false);
  });

  // A socket may only draw on the canvas it joined, not on another one.
  it('is rejected for a canvas other than the one joined', async () => {
    const s = await client();
    await call(s, 'canvas:join', sharedId);
    const res = await call(s, 'stroke:add', stroke(privateId));
    assert.equal(res.ok, false);
  });

  // A draws -> saved in MongoDB, A gets the id, B receives it, A does not get its own stroke back.
  it('is saved, acked with an id, and relayed to others but not back to the sender', async () => {
    const [a, b] = await Promise.all([client(), client()]);
    await call(a, 'canvas:join', sharedId);
    await call(b, 'canvas:join', sharedId);

    const received = next(b, 'stroke:added');
    const echoed = arrives(a, 'stroke:added');
    const ack = await call(a, 'stroke:add', stroke(sharedId, { color: '#ff0000' }));

    assert.equal(ack.ok, true);
    assert.equal(typeof ack.id, 'string');

    const msg = await received;
    assert.equal(msg.id, ack.id);
    assert.equal(msg.color, '#ff0000');
    assert.deepEqual(msg.path, [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    assert.equal(await echoed, false, 'sender must not receive its own stroke');

    const saved = (await listStrokes(sharedId)).map((s) => s._id.toString());
    assert.ok(saved.includes(ack.id), 'stroke is in the database');
  });

  // A connected socket that never joined the canvas receives nothing.
  it('is not delivered to a socket that has not joined the canvas', async () => {
    const [a, outsider] = await Promise.all([client(), client()]);
    await call(a, 'canvas:join', sharedId);
    const leaked = arrives(outsider, 'stroke:added');
    await call(a, 'stroke:add', stroke(sharedId));
    assert.equal(await leaked, false);
  });

  // Rooms are isolated: a stroke on one canvas is not sent to people in another.
  it('reaches only the canvas it was drawn in', async () => {
    const otherId = await createCanvas({ name: 'other shared', isShared: true });
    const [a, b] = await Promise.all([client(), client()]);
    await call(a, 'canvas:join', sharedId);
    await call(b, 'canvas:join', otherId);
    const leaked = arrives(b, 'stroke:added');
    await call(a, 'stroke:add', stroke(sharedId));
    assert.equal(await leaked, false);
  });

  // Bad input (opacity/size out of range, empty or non-numeric or oversized path, empty color, junk) is rejected and not stored.
  it('rejects invalid strokes and saves nothing', async () => {
    const s = await client();
    await call(s, 'canvas:join', sharedId);
    const before = (await listStrokes(sharedId)).length;

    const bad: unknown[] = [
      stroke(sharedId, { opacity: 5 }),
      stroke(sharedId, { size: 0 }),
      stroke(sharedId, { path: [] }),
      stroke(sharedId, { path: [{ x: 'a', y: 1 }] }),
      stroke(sharedId, { path: Array(5001).fill({ x: 1, y: 1 }) }),
      stroke(sharedId, { color: '' }),
      'hello',
      null,
    ];
    for (const payload of bad) {
      const res = await call(s, 'stroke:add', payload);
      assert.equal(res.ok, false, `should reject ${JSON.stringify(payload)?.slice(0, 60)}`);
    }
    assert.equal((await listStrokes(sharedId)).length, before);
  });
});

// Catching up on history, and knowing who is in the canvas.
describe('late joiners and presence', () => {
  // Someone joining after drawing started sees the earlier strokes, in drawing order.
  it('a late joiner receives the strokes saved earlier, oldest first', async () => {
    const canvasId = await createCanvas({ name: 'history', isShared: true });
    const drawer = await client();
    await call(drawer, 'canvas:join', canvasId);
    const first = await call(drawer, 'stroke:add', stroke(canvasId, { color: '#111111' }));
    const second = await call(drawer, 'stroke:add', stroke(canvasId, { color: '#222222' }));

    const late = await client();
    const res = await call(late, 'canvas:join', canvasId);
    assert.deepEqual(res.strokes.map((s: { id: string }) => s.id), [first.id, second.id]);
  });

  // canvas:peers reports the headcount: 1 after A joins, 2 after B joins, 1 after B disconnects.
  it('reports how many participants are in the canvas', async () => {
    const canvasId = await createCanvas({ name: 'presence', isShared: true });
    const a = await client();
    const peersAfterA = next(a, 'canvas:peers');
    await call(a, 'canvas:join', canvasId);
    assert.equal(await peersAfterA, 1);

    const b = await client();
    const peersAfterB = next(a, 'canvas:peers');
    await call(b, 'canvas:join', canvasId);
    assert.equal(await peersAfterB, 2);

    const peersAfterLeave = next(a, 'canvas:peers');
    b.disconnect();
    assert.equal(await peersAfterLeave, 1);
  });

  // A socket is in one canvas at a time: after moving, it stops receiving the old canvas's strokes.
  it('a socket leaves its previous canvas when it joins another', async () => {
    const otherId = await createCanvas({ name: 'second', isShared: true });
    const [mover, stayer] = await Promise.all([client(), client()]);
    await call(mover, 'canvas:join', sharedId);
    await call(stayer, 'canvas:join', sharedId);
    await call(mover, 'canvas:join', otherId);

    const leaked = arrives(mover, 'stroke:added');
    await call(stayer, 'stroke:add', stroke(sharedId));
    assert.equal(await leaked, false, 'mover must no longer receive the old canvas');
  });
});

// Solo mode (private canvas, owner only) and collaboration mode (shared canvas).
describe('solo and collaboration modes', () => {
  // The owner token from canvas creation lets the owner into their own private canvas.
  it('lets the owner join and draw on a private canvas, and see it again on rejoin', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'solo', isShared: false });
    const s = await client();
    const joined = await call(s, 'canvas:join', canvasId, { ownerToken });
    assert.equal(joined.ok, true);
    assert.equal(joined.isShared, false);
    assert.equal(joined.isOwner, true);

    const ack = await call(s, 'stroke:add', stroke(canvasId));
    assert.equal(ack.ok, true);

    const again = await client();
    const rejoined = await call(again, 'canvas:join', canvasId, { ownerToken });
    assert.deepEqual(rejoined.strokes.map((x: { id: string }) => x.id), [ack.id]);
  });

  // No token, a wrong token, or another canvas's token must not open a private canvas.
  it('keeps everyone else out of a private canvas', async () => {
    const mine = await createCanvasWithOwner({ name: 'mine', isShared: false });
    const other = await createCanvasWithOwner({ name: 'other', isShared: false });
    const s = await client();
    for (const opts of [undefined, {}, { ownerToken: 'wrong' }, { ownerToken: other.ownerToken }]) {
      const res = opts === undefined
        ? await call(s, 'canvas:join', mine.canvasId)
        : await call(s, 'canvas:join', mine.canvasId, opts);
      assert.equal(res.ok, false, `should reject ${JSON.stringify(opts)}`);
      assert.match(res.error, /not shared/i);
    }
  });

  // On a shared canvas anyone can join; only the token holder is reported as owner.
  it('reports who is the owner when joining a shared canvas', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'collab', isShared: true });
    const [owner, guest] = await Promise.all([client(), client()]);
    const asOwner = await call(owner, 'canvas:join', canvasId, { ownerToken });
    const asGuest = await call(guest, 'canvas:join', canvasId);
    assert.deepEqual([asOwner.isShared, asOwner.isOwner], [true, true]);
    assert.deepEqual([asGuest.isShared, asGuest.isOwner], [true, false]);
  });

  // Collaboration -> solo: guests are removed, the owner stays and keeps drawing alone.
  it('removes guests but not the owner when the canvas is made private', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'unshare', isShared: true });
    const [owner, guest] = await Promise.all([client(), client()]);
    await call(owner, 'canvas:join', canvasId, { ownerToken });
    await call(guest, 'canvas:join', canvasId);

    // headcounts the owner sees; the "2 here" from the guest's join may still be in flight
    const counts: number[] = [];
    owner.on('canvas:peers', (n: number) => counts.push(n));
    const removed = next(guest, 'canvas:unshared');
    assert.deepEqual(await updateCanvasAndNotify(canvasId, { isShared: false }, ownerToken), { ok: true });
    await removed;
    for (let i = 0; i < 40 && counts.at(-1) !== 1; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(counts.at(-1), 1, `only the owner is left (saw ${JSON.stringify(counts)})`);

    // the guest can no longer draw there or receive strokes
    const guestDraw = await call(guest, 'stroke:add', stroke(canvasId));
    assert.equal(guestDraw.ok, false);
    const leaked = arrives(guest, 'stroke:added');
    const ownerDraw = await call(owner, 'stroke:add', stroke(canvasId));
    assert.equal(ownerDraw.ok, true, 'the owner keeps drawing');
    assert.equal(await leaked, false);

    // and cannot come back while it is private
    assert.equal((await call(guest, 'canvas:join', canvasId)).ok, false);
  });
});

// REST and sockets share one save-and-notify path, and one set of lifecycle rules.
describe('REST and socket consistency', () => {
  // A stroke saved through the service (what POST /strokes calls) is pushed to everyone in the canvas.
  it('delivers a stroke saved over REST to participants already in the canvas', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'rest-push', isShared: true });
    const [a, b] = await Promise.all([client(), client()]);
    await call(a, 'canvas:join', canvasId);
    await call(b, 'canvas:join', canvasId);

    const gotA = next(a, 'stroke:added');
    const gotB = next(b, 'stroke:added');
    const saved = await saveStroke(stroke(canvasId)); // no sender: everyone receives it
    assert.equal(saved.ok, true);
    assert.equal((await gotA).id, saved.ok && saved.id);
    assert.equal((await gotB).id, saved.ok && saved.id);
  });

  // The stroke a socket receives and the one a late joiner is given have the same shape.
  it('uses the same stroke shape live and in the join history', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'shape', isShared: true });
    const [a, b] = await Promise.all([client(), client()]);
    await call(a, 'canvas:join', canvasId);
    await call(b, 'canvas:join', canvasId);
    const live = next(b, 'stroke:added');
    await call(a, 'stroke:add', stroke(canvasId));
    const late = await client();
    const history = (await call(late, 'canvas:join', canvasId)).strokes[0];
    assert.deepEqual(Object.keys(await live).sort(), Object.keys(history).sort());
  });

  // Deleting a canvas removes everyone in it and stops further strokes from being saved.
  it('removes participants when the canvas is deleted, and refuses strokes afterwards', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'delete', isShared: true });
    const [owner, guest] = await Promise.all([client(), client()]);
    await call(owner, 'canvas:join', canvasId, { ownerToken });
    await call(guest, 'canvas:join', canvasId);

    const goneOwner = next(owner, 'canvas:deleted');
    const goneGuest = next(guest, 'canvas:deleted');
    assert.deepEqual(await deleteCanvasWithStrokes(canvasId, ownerToken), { ok: true });
    await Promise.all([goneOwner, goneGuest]);

    assert.equal((await call(guest, 'stroke:add', stroke(canvasId))).ok, false);
    assert.equal((await call(guest, 'canvas:join', canvasId)).ok, false);
  });
});

// Undo removes your own latest stroke; clear removes everything and is owner only.
describe('undo and clear', () => {
  const ids = (strokes: { id: string }[]) => strokes.map((s) => s.id);

  // Undo takes back the sender's newest stroke, the others are told, and the history reflects it.
  it('undoes the sender\'s latest stroke and tells the others', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'undo', isShared: true });
    const [a, b] = await Promise.all([client(), client()]);
    await call(a, 'canvas:join', canvasId);
    await call(b, 'canvas:join', canvasId);
    const first = await call(a, 'stroke:add', stroke(canvasId));
    const second = await call(a, 'stroke:add', stroke(canvasId));

    const told = next(b, 'stroke:removed');
    const echoed = arrives(a, 'stroke:removed');
    const undone = await call(a, 'stroke:undo');
    assert.deepEqual(undone, { ok: true, id: second.id });
    assert.equal(await told, second.id);
    assert.equal(await echoed, false, 'the sender is not told about its own undo');

    const late = await client();
    assert.deepEqual(ids((await call(late, 'canvas:join', canvasId)).strokes), [first.id]);

    assert.equal((await call(a, 'stroke:undo')).ok, true);
    const empty = await call(a, 'stroke:undo');
    assert.deepEqual(empty, { ok: false, error: 'Nothing to undo' });
  });

  // Guests undo their own strokes and cannot remove the owner's.
  it('only undoes your own strokes', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'mine', isShared: true });
    const [owner, guest] = await Promise.all([client(), client()]);
    await call(owner, 'canvas:join', canvasId, { ownerToken });
    await call(guest, 'canvas:join', canvasId);
    const ownerStroke = await call(owner, 'stroke:add', stroke(canvasId));
    const guestStroke = await call(guest, 'stroke:add', stroke(canvasId)); // drawn last

    assert.deepEqual(await call(owner, 'stroke:undo'), { ok: true, id: ownerStroke.id });
    assert.deepEqual(await call(guest, 'stroke:undo'), { ok: true, id: guestStroke.id });
    assert.equal((await call(owner, 'stroke:undo')).ok, false);
  });

  // The owner stays the same author across reconnects, so undo works after a reload.
  it('lets the owner undo strokes drawn in an earlier connection', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'reload', isShared: false });
    const before = await client();
    await call(before, 'canvas:join', canvasId, { ownerToken });
    const drawn = await call(before, 'stroke:add', stroke(canvasId));
    before.disconnect();

    const after = await client();
    await call(after, 'canvas:join', canvasId, { ownerToken });
    assert.deepEqual(await call(after, 'stroke:undo'), { ok: true, id: drawn.id });
  });

  // Strokes saved over REST have no author, so undo ignores them.
  it('cannot undo a stroke that was saved over REST', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'rest', isShared: true });
    const s = await client();
    await call(s, 'canvas:join', canvasId);
    await saveStroke(stroke(canvasId));
    assert.deepEqual(await call(s, 'stroke:undo'), { ok: false, error: 'Nothing to undo' });
  });

  // Undo and clear need a joined canvas.
  it('are refused before joining a canvas', async () => {
    const s = await client();
    assert.equal((await call(s, 'stroke:undo')).ok, false);
    assert.equal((await call(s, 'canvas:clear')).ok, false);
  });

  // The owner clears the canvas: strokes are deleted, others are told, history is empty.
  it('lets the owner clear the canvas and tells the others', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'clear', isShared: true });
    const [owner, guest] = await Promise.all([client(), client()]);
    await call(owner, 'canvas:join', canvasId, { ownerToken });
    await call(guest, 'canvas:join', canvasId);
    await call(owner, 'stroke:add', stroke(canvasId));
    await call(guest, 'stroke:add', stroke(canvasId));

    const told = next(guest, 'canvas:cleared');
    const echoed = arrives(owner, 'canvas:cleared');
    assert.deepEqual(await call(owner, 'canvas:clear'), { ok: true, removed: 2 });
    await told;
    assert.equal(await echoed, false, 'the owner is not told about its own clear');

    const late = await client();
    assert.deepEqual((await call(late, 'canvas:join', canvasId)).strokes, []);
    assert.equal((await call(guest, 'stroke:undo')).ok, false, 'nothing left to undo');
  });

  // Guests cannot clear, and nothing is lost when they try.
  it('refuses a guest who tries to clear the canvas', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'guarded', isShared: true });
    const guest = await client();
    await call(guest, 'canvas:join', canvasId);
    await call(guest, 'stroke:add', stroke(canvasId));

    const res = await call(guest, 'canvas:clear');
    assert.equal(res.ok, false);
    assert.match(res.error, /owner/i);
    assert.equal((await listStrokes(canvasId)).length, 1);
  });
});

// Deleting one stroke by id (the eraser), as opposed to undo (own latest) and clear (owner, all).
describe('stroke:delete', () => {
  it('deletes a stroke by id and tells the others but not the sender', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'erase', isShared: true });
    const [a, b] = await Promise.all([client(), client()]);
    await call(a, 'canvas:join', canvasId);
    await call(b, 'canvas:join', canvasId);
    const keep = await call(a, 'stroke:add', stroke(canvasId));
    const doomed = await call(b, 'stroke:add', stroke(canvasId)); // anyone in the canvas may delete it

    const told = next(b, 'stroke:deleted');
    const echoed = arrives(a, 'stroke:deleted');
    assert.deepEqual(await call(a, 'stroke:delete', doomed.id), { ok: true });
    assert.equal(await told, doomed.id);
    assert.equal(await echoed, false, 'the sender is not told about its own delete');
    assert.deepEqual((await listStrokes(canvasId)).map((x) => x._id.toString()), [keep.id]);

    const missing = await call(a, 'stroke:delete', doomed.id);
    assert.deepEqual(missing, { ok: false, error: 'Stroke not found' });
    assert.equal((await call(a, 'stroke:delete', 'nope')).ok, false);
  });

  it('is refused before joining a canvas', async () => {
    const s = await client();
    assert.equal((await call(s, 'stroke:delete', '6abe45dcc09e70d0e46e4bbb')).ok, false);
  });

  it('is delivered to participants when deleted through the service (REST)', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'rest-erase', isShared: true });
    const a = await client();
    await call(a, 'canvas:join', canvasId);
    const drawn = await call(a, 'stroke:add', stroke(canvasId));
    const told = next(a, 'stroke:deleted');
    assert.deepEqual(await deleteStrokeById(canvasId, drawn.id), { ok: true });
    assert.equal(await told, drawn.id);
  });
});

// Shapes, photos and cutouts: validated, saved, and relayed like strokes.
describe('elements', () => {
  const join = async (canvasId: string, ownerToken?: string) => {
    const s = await client();
    const res = await (ownerToken ? call(s, 'canvas:join', canvasId, { ownerToken }) : call(s, 'canvas:join', canvasId));
    return { s, res };
  };

  it('element:add is saved, acked with an id, relayed to others but not back to the sender', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'el-add', isShared: true });
    const [{ s: a }, { s: b }] = await Promise.all([join(canvasId), join(canvasId)]);

    const received = next(b, 'element:added');
    const echoed = arrives(a, 'element:added');
    const ack = await call(a, 'element:add', element(canvasId, { color: null }));
    assert.equal(ack.ok, true);
    assert.equal(typeof ack.id, 'string');

    const msg = await received;
    assert.equal(msg.id, ack.id);
    assert.equal(msg.type, 'shape');
    assert.equal(msg.color, null);
    assert.equal('_id' in msg, false);
    assert.equal(await echoed, false, 'sender must not receive its own element');
    assert.deepEqual((await listElements(canvasId)).map((e) => e._id.toString()), [ack.id]);
  });

  it('element:add is refused before joining, for another canvas, and for invalid elements', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'el-bad', isShared: true });
    const other = await createCanvasWithOwner({ name: 'el-other', isShared: true });
    const loner = await client();
    assert.equal((await call(loner, 'element:add', element(canvasId))).ok, false, 'not joined');

    const { s } = await join(canvasId);
    assert.equal((await call(s, 'element:add', element(other.canvasId))).ok, false, 'other canvas');
    const bad: unknown[] = [
      element(canvasId, { type: 'sticker' }), element(canvasId, { width: -1 }), element(canvasId, { x: 'a' }),
      element(canvasId, { shape: 'blob' }), 'hello', null,
    ];
    for (const payload of bad) assert.equal((await call(s, 'element:add', payload)).ok, false);
    assert.equal((await listElements(canvasId)).length, 0);
  });

  it('element:update changes the element, relays the full new state, and does not echo', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'el-update', isShared: true });
    const [{ s: a }, { s: b }] = await Promise.all([join(canvasId), join(canvasId)]);
    const { id } = await call(a, 'element:add', element(canvasId));

    const told = next(b, 'element:updated');
    const echoed = arrives(a, 'element:updated');
    assert.deepEqual(await call(a, 'element:update', id, { x: 77, rotation: 45 }), { ok: true });
    const msg = await told;
    assert.deepEqual([msg.id, msg.x, msg.rotation, msg.width], [id, 77, 45, 100]);
    assert.equal(await echoed, false);

    assert.equal((await call(a, 'element:update', id, {})).ok, false, 'empty change');
    assert.equal((await call(a, 'element:update', id, { width: 0 })).ok, false, 'invalid change');
    assert.deepEqual(await call(a, 'element:update', '6abe45dcc09e70d0e46e4bbb', { x: 1 }), { ok: false, error: 'Element not found' });
    assert.equal((await call(a, 'element:update', 'nope', { x: 1 })).ok, false);
    assert.equal((await listElements(canvasId))[0]!.x, 77);
  });

  it('element:delete removes the element and tells the others but not the sender', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'el-delete', isShared: true });
    const [{ s: a }, { s: b }] = await Promise.all([join(canvasId), join(canvasId)]);
    const { id } = await call(b, 'element:add', element(canvasId));

    const told = next(b, 'element:deleted');
    const echoed = arrives(a, 'element:deleted');
    assert.deepEqual(await call(a, 'element:delete', id), { ok: true });
    assert.equal(await told, id);
    assert.equal(await echoed, false);
    assert.equal((await listElements(canvasId)).length, 0);
    assert.deepEqual(await call(a, 'element:delete', id), { ok: false, error: 'Element not found' });
  });

  it('update and delete are refused before joining a canvas', async () => {
    const s = await client();
    assert.equal((await call(s, 'element:update', '6abe45dcc09e70d0e46e4bbb', { x: 1 })).ok, false);
    assert.equal((await call(s, 'element:delete', '6abe45dcc09e70d0e46e4bbb')).ok, false);
  });

  it('cannot touch elements of another canvas', async () => {
    const mine = await createCanvasWithOwner({ name: 'el-mine', isShared: true });
    const theirs = await createCanvasWithOwner({ name: 'el-theirs', isShared: true });
    const added = await addElement(parseElement(element(theirs.canvasId))!);
    const id = added.ok ? added.id : '';
    const { s } = await join(mine.canvasId);
    assert.equal((await call(s, 'element:update', id, { x: 1 })).ok, false);
    assert.equal((await call(s, 'element:delete', id)).ok, false);
    assert.equal((await listElements(theirs.canvasId)).length, 1);
  });

  it('is not delivered to a socket outside the canvas or in another one', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'el-iso', isShared: true });
    const other = await createCanvasWithOwner({ name: 'el-iso2', isShared: true });
    const [{ s: a }, outsider, { s: elsewhere }] = await Promise.all([join(canvasId), client(), join(other.canvasId)]);
    const leaked = Promise.all([arrives(outsider, 'element:added'), arrives(elsewhere, 'element:added')]);
    await call(a, 'element:add', element(canvasId));
    assert.deepEqual(await leaked, [false, false]);
  });

  it('a late joiner gets the elements in the join ack, oldest first, in the same shape as live', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'el-history', isShared: true });
    const [{ s: a }, { s: b }] = await Promise.all([join(canvasId), join(canvasId)]);
    const live = next(b, 'element:added');
    const first = await call(a, 'element:add', element(canvasId));
    const second = await call(a, 'element:add', element(canvasId, { shape: 'star' }));

    const { res } = await join(canvasId);
    assert.deepEqual(res.elements.map((e: { id: string }) => e.id), [first.id, second.id]);
    assert.deepEqual(Object.keys(await live).sort(), Object.keys(res.elements[0]).sort());
  });

  it('a cutout round-trips with its photo box', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'el-cutout', isShared: true });
    const { s } = await join(canvasId);
    const cut = element(canvasId, {
      type: 'cutout', shape: 'heart', color: undefined, url: 'https://images.unsplash.com/photo-1',
      photographer: 'Ann', photographerLink: 'https://unsplash.com/@ann', cutWidth: 80, cutHeight: 60,
      photo: { x: -5, y: 5, width: 300, height: 200, rotation: 10 },
    });
    assert.equal((await call(s, 'element:add', cut)).ok, true);
    const { res } = await join(canvasId);
    assert.deepEqual(res.elements[0].photo, { x: -5, y: 5, width: 300, height: 200, rotation: 10 });
    assert.equal(res.elements[0].cutWidth, 80);
    assert.equal(res.elements[0].shape, 'heart');
  });

  it('keeps everyone but the owner out of a private canvas, elements included', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'el-solo', isShared: false });
    const { s, res } = await join(canvasId, ownerToken);
    assert.equal(res.ok, true);
    assert.equal((await call(s, 'element:add', element(canvasId))).ok, true);

    const intruder = await client();
    assert.equal((await call(intruder, 'canvas:join', canvasId)).ok, false);
    assert.equal((await call(intruder, 'element:add', element(canvasId))).ok, false);
    assert.equal((await listElements(canvasId)).length, 1);
  });

  it('element REST saves reach participants already in the canvas', async () => {
    const { canvasId } = await createCanvasWithOwner({ name: 'el-rest', isShared: true });
    const { s } = await join(canvasId);
    const told = next(s, 'element:added');
    const saved = await addElement(parseElement(element(canvasId))!); // no sender: everyone receives it
    assert.equal((await told).id, saved.ok && saved.id);
  });

  it('removes the elements with the canvas', async () => {
    const { canvasId, ownerToken } = await createCanvasWithOwner({ name: 'el-gone', isShared: true });
    const { s } = await join(canvasId, ownerToken);
    await call(s, 'element:add', element(canvasId));
    const gone = next(s, 'canvas:deleted');
    assert.deepEqual(await deleteCanvasWithStrokes(canvasId, ownerToken), { ok: true });
    await gone;
    assert.equal((await listElements(canvasId)).length, 0);
    assert.equal((await call(s, 'element:add', element(canvasId))).ok, false);
  });
});
