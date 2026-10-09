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

// Imported after the env var is set (static imports would run first).
const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { registerCanvasSocket } = await import('../src/canvas.socket.js');
const { createCanvas } = await import('../src/canvas.repository.js');
const { listStrokes } = await import('../src/stroke.repository.js');

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
