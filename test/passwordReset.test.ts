// HTTP tests for /api/auth/forgot-password and /api/auth/reset-password against a real (test) MongoDB.
// Run with: npm run test:reset   (MongoDB must be running)
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler } from 'express';
import jwt from 'jsonwebtoken';

const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri; // db.ts reads these when first imported
process.env.JWT_SECRET = 'test-secret';
delete process.env.SMTP_URL; // no real e-mail is ever sent by the tests

const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { authRouter } = await import('../src/routes/auth.routes.js');
const { createUser, ensureUserIndexes, findUserByEmail } = await import('../src/repositories/user.repository.js');
const { passwordFingerprint, signResetToken } = await import('../src/services/auth.service.js');

let httpServer: HttpServer;
let base: string;

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let accountCount = 0;
/** A new password account, so no test depends on what another one changed. */
async function newAccount(password = 'sketch123') {
  const email = `reset${++accountCount}@example.com`;
  const res = await api('POST', '/api/auth/register', { email, password, displayName: 'Reset Tester' });
  assert.equal(res.status, 201);
  const { token } = await res.json();
  const user = await findUserByEmail(email);
  assert.ok(user?.passwordHash);
  return { email, password, loginToken: token as string, id: user._id.toString(), passwordHash: user.passwordHash };
}

const login = (email: string, password: string) => api('POST', '/api/auth/login', { email, password });
const reset = (token: string, password: string) => api('POST', '/api/auth/reset-password', { token, password });

before(async () => {
  await connectDB();
  await getDb().dropDatabase(); // start clean
  await ensureUserIndexes();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  const errorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  };
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

describe('POST /api/auth/forgot-password', () => {
  it('answers 400 for something that is not an e-mail address', async () => {
    for (const email of [undefined, '', 'nope', 42]) {
      const res = await api('POST', '/api/auth/forgot-password', { email });
      assert.equal(res.status, 400, String(email));
    }
  });

  it('answers the same for an address with an account and one without: nobody can find out who has an account', async () => {
    const account = await newAccount();
    const known = await api('POST', '/api/auth/forgot-password', { email: account.email });
    const unknown = await api('POST', '/api/auth/forgot-password', { email: 'nobody-here@example.com' });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), { ok: true });
    assert.deepEqual(await unknown.json(), { ok: true });
  });

  it('does not change the password', async () => {
    const account = await newAccount();
    await api('POST', '/api/auth/forgot-password', { email: account.email });
    assert.equal((await login(account.email, account.password)).status, 200);
  });
});

describe('POST /api/auth/reset-password', () => {
  it('sets the new password: it works for login, the old one does not', async () => {
    const account = await newAccount();
    const res = await reset(signResetToken(account.id, account.passwordHash), 'newpass456');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    assert.equal((await login(account.email, 'newpass456')).status, 200);
    assert.equal((await login(account.email, account.password)).status, 401);
  });

  it('works once: the same link cannot be used again', async () => {
    const account = await newAccount();
    const token = signResetToken(account.id, account.passwordHash);
    assert.equal((await reset(token, 'newpass456')).status, 200);

    const again = await reset(token, 'another789');
    assert.equal(again.status, 400);
    assert.equal(typeof (await again.json()).error, 'string');
    assert.equal((await login(account.email, 'newpass456')).status, 200, 'the password is still the first new one');
  });

  it('refuses a missing, random, tampered or expired token', async () => {
    const account = await newAccount();
    const good = signResetToken(account.id, account.passwordHash);

    assert.equal((await api('POST', '/api/auth/reset-password', { password: 'newpass456' })).status, 400);
    assert.equal((await reset('not a token', 'newpass456')).status, 400);
    assert.equal((await reset(good.slice(0, -3) + 'abc', 'newpass456')).status, 400);

    const resetKey = createHmac('sha256', 'test-secret').update('password-reset').digest();
    const expired = jwt.sign({ pw: passwordFingerprint(account.passwordHash) }, resetKey, { subject: account.id, expiresIn: -10 });
    assert.equal((await reset(expired, 'newpass456')).status, 400);

    assert.equal((await login(account.email, account.password)).status, 200, 'nothing changed');
  });

  it('refuses a weak password and keeps the link usable', async () => {
    const account = await newAccount();
    const token = signResetToken(account.id, account.passwordHash);
    for (const password of ['short1', 'onlyletters', '12345678', undefined]) {
      assert.equal((await reset(token, password as string)).status, 400, String(password));
    }
    assert.equal((await reset(token, 'newpass456')).status, 200);
  });

  it('does not accept a login token in place of a reset token', async () => {
    const account = await newAccount();
    assert.equal((await reset(account.loginToken, 'newpass456')).status, 400);
    assert.equal((await login(account.email, account.password)).status, 200);
  });

  it('does not accept the link of a deleted account', async () => {
    const account = await newAccount();
    const token = signResetToken(account.id, account.passwordHash);
    await getDb().collection('users').deleteOne({ email: account.email });
    assert.equal((await reset(token, 'newpass456')).status, 400);
  });

  it('lets an account that only had Google sign-in choose a password', async () => {
    const created = await createUser({ email: 'google-only@example.com', displayName: 'Google Only', googleId: 'g-12345' });
    assert.equal((await login('google-only@example.com', 'newpass456')).status, 401);

    const res = await reset(signResetToken(created._id.toString(), undefined), 'newpass456');
    assert.equal(res.status, 200);
    assert.equal((await login('google-only@example.com', 'newpass456')).status, 200);
  });
});
