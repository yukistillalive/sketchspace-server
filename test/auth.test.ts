// HTTP tests for /api/auth and /api/users against a real (test) MongoDB.
// Run with: npm run test:auth   (MongoDB must be running)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server as HttpServer } from 'node:http';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler } from 'express';

const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri; // db.ts reads these when first imported
process.env.JWT_SECRET = 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'; // so /google runs (a fake token is rejected)

const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { authRouter } = await import('../src/routes/auth.routes.js');
const { userRouter } = await import('../src/routes/user.routes.js');
const { ensureUserIndexes, findUserByEmail } = await import('../src/repositories/user.repository.js');

let httpServer: HttpServer;
let base: string;

const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const account = { email: 'maryam@example.com', password: 'sketch123', displayName: 'Maryam' };

before(async () => {
  await connectDB();
  await getDb().dropDatabase(); // start clean
  await ensureUserIndexes();

  const errorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);
  app.use(errorHandler);

  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  base = `http://localhost:${(httpServer.address() as { port: number }).port}`;
});

after(async () => {
  await getDb().dropDatabase();
  await closeDB();
  httpServer.close();
});

describe('POST /api/auth/register', () => {
  it('creates the account: 201, token, httpOnly cookie, no password hash, saved in the database', async () => {
    const res = await api('POST', '/api/auth/register', account);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(typeof body.token, 'string');
    assert.equal(body.user.email, account.email);
    assert.equal(body.user.displayName, 'Maryam');
    assert.ok(!('passwordHash' in body.user) && !('password' in body.user));

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('token='));
    assert.ok(cookie?.includes('HttpOnly'), 'cookie must be httpOnly');

    const saved = await findUserByEmail(account.email);
    assert.ok(saved?.passwordHash && saved.passwordHash !== account.password, 'password is stored hashed');
  });

  it('answers 409 for an email already registered (any letter case)', async () => {
    const res = await api('POST', '/api/auth/register', { ...account, email: 'MARYAM@example.com' });
    assert.equal(res.status, 409);
  });

  it('answers 400 for invalid input', async () => {
    const bad = [
      { ...account, email: 'not-an-email' },
      { ...account, password: 'short' },
      { ...account, password: 'onlyletters' },
      { ...account, displayName: '<script>' },
      {},
    ];
    for (const body of bad) assert.equal((await api('POST', '/api/auth/register', body)).status, 400);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with the right credentials (email is case-insensitive)', async () => {
    const res = await api('POST', '/api/auth/login', { email: 'Maryam@Example.com', password: account.password });
    assert.equal(res.status, 200);
    assert.equal(typeof (await res.json()).token, 'string');
  });

  it('answers 401 with the same message for a wrong password and an unknown email', async () => {
    const wrong = await api('POST', '/api/auth/login', { email: account.email, password: 'wrong-pass1' });
    const unknown = await api('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'sketch123' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal((await wrong.json()).error, (await unknown.json()).error);
  });

  it('answers 400 when fields are missing', async () => {
    assert.equal((await api('POST', '/api/auth/login', { email: account.email })).status, 400);
  });
});

describe('/api/users/me (needs a valid token)', () => {
  let token: string;
  before(async () => {
    const res = await api('POST', '/api/auth/login', { email: account.email, password: account.password });
    token = (await res.json()).token;
  });

  it('answers 401 without a token and with an invalid one', async () => {
    assert.equal((await api('GET', '/api/users/me')).status, 401);
    assert.equal((await api('GET', '/api/users/me', undefined, bearer('not.a.token'))).status, 401);
  });

  it('returns the profile with a bearer token or with the cookie', async () => {
    const viaHeader = await api('GET', '/api/users/me', undefined, bearer(token));
    assert.equal(viaHeader.status, 200);
    assert.equal((await viaHeader.json()).email, account.email);

    const viaCookie = await api('GET', '/api/users/me', undefined, { Cookie: `token=${token}` });
    assert.equal(viaCookie.status, 200);
  });

  it('updates the profile and the change survives a reload', async () => {
    const put = await api('PUT', '/api/users/me', { displayName: 'Maryam K', avatarUrl: 'https://example.com/m.png' }, bearer(token));
    assert.equal(put.status, 200);

    const again = await (await api('GET', '/api/users/me', undefined, bearer(token))).json();
    assert.equal(again.displayName, 'Maryam K');
    assert.equal(again.avatarUrl, 'https://example.com/m.png');
  });

  it('removes the avatar when avatarUrl is null', async () => {
    await api('PUT', '/api/users/me', { avatarUrl: null }, bearer(token));
    const me = await (await api('GET', '/api/users/me', undefined, bearer(token))).json();
    assert.ok(!('avatarUrl' in me));
  });

  it('answers 400 for an empty or invalid update', async () => {
    for (const body of [{}, { displayName: 'x' }, { avatarUrl: 'http://insecure.example.com/a.png' }])
      assert.equal((await api('PUT', '/api/users/me', body, bearer(token))).status, 400);
  });

  it('deletes the account; the old token then stops working', async () => {
    const del = await api('DELETE', '/api/users/me', undefined, bearer(token));
    assert.equal(del.status, 200);
    assert.equal(await findUserByEmail(account.email), null);
    assert.equal((await api('GET', '/api/users/me', undefined, bearer(token))).status, 401);
  });
});

describe('POST /api/auth/google', () => {
  it('answers 400 without an idToken', async () => {
    assert.equal((await api('POST', '/api/auth/google', {})).status, 400);
  });

  it('answers 401 for a token Google did not issue', async () => {
    assert.equal((await api('POST', '/api/auth/google', { idToken: 'forged.token.value' })).status, 401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie', async () => {
    const res = await api('POST', '/api/auth/logout');
    assert.equal(res.status, 200);
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('token=;')));
  });
});
