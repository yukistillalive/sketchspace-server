// Canvases that belong to an account: HTTP and socket tests against a real (test) MongoDB.
// Run with: npm run test:ownership   (MongoDB must be running)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server as HttpServer } from 'node:http';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';

const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri;
process.env.JWT_SECRET = 'test-secret';

const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { authRouter } = await import('../src/routes/auth.routes.js');
const { userRouter } = await import('../src/routes/user.routes.js');
const { canvasRouter } = await import('../src/routes/canvas.routes.js');
const { strokeRouter } = await import('../src/routes/stroke.routes.js');
const { registerCanvasSocket } = await import('../src/socket/canvas.socket.js');
const { ensureUserIndexes } = await import('../src/repositories/user.repository.js');
const { findCanvas } = await import('../src/repositories/canvas.repository.js');
const { listStrokes } = await import('../src/repositories/stroke.repository.js');

let httpServer: HttpServer;
let io: Server;
let base: string;
const sockets: Socket[] = [];

const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Registers an account; resolves to the cookie header that keeps it logged in. */
async function register(name: string): Promise<string> {
  const res = await api('POST', '/api/auth/register', {
    email: `${name}@example.com`, password: 'sketch123', displayName: name,
  });
  assert.equal(res.status, 201);
  return `token=${((await res.json()) as { token: string }).token}`;
}

const asUser = (cookie: string) => ({ Cookie: cookie });
const asToken = (ownerToken: string) => ({ 'X-Owner-Token': ownerToken });

async function create(body: object, headers: Record<string, string> = {}) {
  const res = await api('POST', '/api/canvas', body, headers);
  assert.equal(res.status, 201);
  return (await res.json()) as { canvasId: string; ownerToken: string };
}

const connectAs = (cookie?: string): Promise<Socket> =>
  new Promise((resolve) => {
    const s = connect(`http://localhost:${(httpServer.address() as { port: number }).port}`, {
      forceNew: true,
      ...(cookie && { extraHeaders: { Cookie: cookie } }),
    });
    sockets.push(s);
    s.on('connect', () => resolve(s));
  });

const call = (s: Socket, event: string, ...args: unknown[]): Promise<any> =>
  new Promise((resolve) => s.emit(event, ...args, resolve));

let alice: string;
let bob: string;

before(async () => {
  await connectDB();
  await getDb().dropDatabase();
  await ensureUserIndexes();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/canvas', canvasRouter);
  app.use('/api/canvas', strokeRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);
  httpServer = createServer(app);
  io = new Server(httpServer);
  registerCanvasSocket(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  base = `http://localhost:${(httpServer.address() as { port: number }).port}`;

  alice = await register('alice');
  bob = await register('bob');
});

after(async () => {
  sockets.forEach((s) => s.close());
  await io.close();
  await getDb().dropDatabase();
  await closeDB();
});

describe('a canvas created while logged in', () => {
  it('belongs to the account: no owner token needed to open or change it', async () => {
    const { canvasId } = await create({ name: 'mine', isShared: false }, asUser(alice));

    const read = await api('GET', `/api/canvas/${canvasId}`, undefined, asUser(alice));
    assert.equal(read.status, 200);
    const canvas = (await read.json()) as Record<string, unknown>;
    assert.equal(canvas.isOwner, true);
    assert.equal('ownerUserId' in canvas, false, 'the owner account is never sent');

    assert.equal((await api('PUT', `/api/canvas/${canvasId}`, { name: 'renamed' }, asUser(alice))).status, 200);
    assert.equal((await findCanvas(canvasId))?.name, 'renamed');
  });

  it('is refused to other accounts and guests while private', async () => {
    const { canvasId } = await create({ isShared: false }, asUser(alice));
    assert.equal((await api('GET', `/api/canvas/${canvasId}`, undefined, asUser(bob))).status, 403);
    assert.equal((await api('GET', `/api/canvas/${canvasId}`)).status, 403);
    assert.equal((await api('GET', `/api/canvas/${canvasId}/strokes`, undefined, asUser(bob))).status, 403);
  });

  it('can be read by others once shared, but only the owner can change or delete it', async () => {
    const { canvasId } = await create({ name: 'open', isShared: true }, asUser(alice));
    const asBob = await api('GET', `/api/canvas/${canvasId}`, undefined, asUser(bob));
    assert.equal(asBob.status, 200);
    assert.equal(((await asBob.json()) as { isOwner: boolean }).isOwner, false);

    assert.equal((await api('PUT', `/api/canvas/${canvasId}`, { name: 'x' }, asUser(bob))).status, 403);
    assert.equal((await api('DELETE', `/api/canvas/${canvasId}`, undefined, asUser(bob))).status, 403);
    assert.equal((await api('DELETE', `/api/canvas/${canvasId}/strokes`, undefined, asUser(bob))).status, 403);
    assert.equal((await api('DELETE', `/api/canvas/${canvasId}`, undefined, asUser(alice))).status, 200);
  });

  it('still works with the owner token alone (a guest on the same device)', async () => {
    const { canvasId, ownerToken } = await create({ isShared: false }, asUser(alice));
    assert.equal((await api('GET', `/api/canvas/${canvasId}`, undefined, asToken(ownerToken))).status, 200);
  });
});

describe('a canvas created as a guest', () => {
  it('has no account owner and keeps working with its token', async () => {
    const { canvasId, ownerToken } = await create({ isShared: false });
    assert.equal((await findCanvas(canvasId))?.ownerUserId, undefined);
    assert.equal((await api('GET', `/api/canvas/${canvasId}`, undefined, asUser(alice))).status, 403);
    const owner = await api('GET', `/api/canvas/${canvasId}`, undefined, asToken(ownerToken));
    assert.equal(((await owner.json()) as { isOwner: boolean }).isOwner, true);
  });
});

describe('GET /api/canvas/mine', () => {
  it('needs a login', async () => {
    assert.equal((await api('GET', '/api/canvas/mine')).status, 401);
  });

  it("lists only the account's canvases, shared and private", async () => {
    const carol = await register('carol');
    await create({ name: 'c-private', isShared: false }, asUser(carol));
    await create({ name: 'c-shared', isShared: true }, asUser(carol));
    await create({ name: 'someone-else', isShared: true }, asUser(bob));
    await create({ name: 'guest-one', isShared: true });

    const res = await api('GET', '/api/canvas/mine', undefined, asUser(carol));
    assert.equal(res.status, 200);
    const names = ((await res.json()) as { name: string }[]).map((c) => c.name).sort();
    assert.deepEqual(names, ['c-private', 'c-shared']);
  });
});

describe('POST /api/canvas/:id/claim', () => {
  it('attaches a token-owned canvas to the account, which then owns it without the token', async () => {
    const dave = await register('dave');
    const { canvasId, ownerToken } = await create({ name: 'old', isShared: false });
    const claim = await api('POST', `/api/canvas/${canvasId}/claim`, undefined, { ...asUser(dave), ...asToken(ownerToken) });
    assert.equal(claim.status, 200);

    assert.equal((await api('GET', `/api/canvas/${canvasId}`, undefined, asUser(dave))).status, 200);
    const mine = (await (await api('GET', '/api/canvas/mine', undefined, asUser(dave))).json()) as { name: string }[];
    assert.deepEqual(mine.map((c) => c.name), ['old']);
  });

  it('is refused without a login, with a wrong token, or for a canvas of another account', async () => {
    const { canvasId, ownerToken } = await create({ isShared: false });
    assert.equal((await api('POST', `/api/canvas/${canvasId}/claim`, undefined, asToken(ownerToken))).status, 401);
    assert.equal((await api('POST', `/api/canvas/${canvasId}/claim`, undefined, { ...asUser(bob), ...asToken('wrong') })).status, 403);

    const owned = await create({ isShared: false }, asUser(alice));
    const stolen = await api('POST', `/api/canvas/${owned.canvasId}/claim`, undefined, { ...asUser(bob), ...asToken(owned.ownerToken) });
    assert.equal(stolen.status, 403, 'a canvas that belongs to an account cannot be taken over');
  });
});

describe('sockets', () => {
  it('lets the account owner join their private canvas without a token, and marks them owner', async () => {
    const { canvasId } = await create({ isShared: false }, asUser(alice));

    const owner = await call(await connectAs(alice), 'canvas:join', canvasId);
    assert.equal(owner.ok, true);
    assert.equal(owner.isOwner, true);

    assert.equal((await call(await connectAs(bob), 'canvas:join', canvasId)).ok, false);
    assert.equal((await call(await connectAs(), 'canvas:join', canvasId)).ok, false);
  });

  it('lets only the account owner clear the canvas', async () => {
    const { canvasId } = await create({ isShared: true }, asUser(alice));
    const s = await connectAs(alice);
    await call(s, 'canvas:join', canvasId);
    await call(s, 'stroke:add', {
      canvasId, layerId: 'foreground', brush: 'pen', size: 4, color: '#000', opacity: 1, path: [{ x: 1, y: 1 }],
    });

    const guest = await connectAs(bob);
    await call(guest, 'canvas:join', canvasId);
    assert.equal((await call(guest, 'canvas:clear')).ok, false);
    assert.equal((await call(s, 'canvas:clear')).ok, true);
    assert.equal((await listStrokes(canvasId)).length, 0);
  });
});

describe('deleting an account', () => {
  it('deletes the canvases it owns, and leaves everyone else alone', async () => {
    const erin = await register('erin');
    const mine = await create({ name: 'doomed', isShared: true }, asUser(erin));
    const other = await create({ name: 'kept', isShared: true }, asUser(alice));

    assert.equal((await api('DELETE', '/api/users/me', undefined, asUser(erin))).status, 200);
    assert.equal(await findCanvas(mine.canvasId), null);
    assert.notEqual(await findCanvas(other.canvasId), null);
  });
});
