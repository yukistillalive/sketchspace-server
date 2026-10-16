// HTTP tests for the profile picture: /api/users/me/avatar, /uploads and the Google picture, against a real
// (test) MongoDB. Pictures are written to a temporary folder.
// Run with: npm run test:avatar   (MongoDB must be running)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';

const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri; // db.ts reads these when first imported
process.env.JWT_SECRET = 'test-secret';
const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'sketchspace-avatar-http-'));
process.env.UPLOAD_DIR = uploadDir; // avatar.service.ts reads this when first imported

const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { authRouter } = await import('../src/routes/auth.routes.js');
const { userRouter } = await import('../src/routes/user.routes.js');
const { MAX_AVATAR_BYTES } = await import('../src/services/avatar.service.js');
const { ensureUserIndexes } = await import('../src/repositories/user.repository.js');

let httpServer: HttpServer;
let base: string;

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface Account {
  id: string;
  email: string;
  token: string;
}

let accountCount = 0;
/** A new account, so no test depends on what another one left behind. */
async function newAccount(): Promise<Account> {
  const email = `avatar${++accountCount}@example.com`;
  const res = await api('POST', '/api/auth/register', { email, password: 'sketch123', displayName: 'Avatar Tester' });
  assert.equal(res.status, 201);
  const body = await res.json();
  return { id: body.user.id, email, token: body.token };
}

const upload = (account: Account, data: Buffer, contentType = 'image/png') =>
  fetch(`${base}/api/users/me/avatar`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...bearer(account.token) },
    body: data as RequestInit['body'],
  });

const removeAvatar = (account: Account) => api('DELETE', '/api/users/me/avatar', undefined, bearer(account.token));

const me = async (account: Account) => (await api('GET', '/api/users/me', undefined, bearer(account.token))).json();

/** Where the file of an avatarUrl (/uploads/avatars/<name>) lies on disk. */
const fileOf = (avatarUrl: string): string => path.join(uploadDir, 'avatars', path.basename(avatarUrl));

before(async () => {
  await connectDB();
  await getDb().dropDatabase(); // start clean
  await ensureUserIndexes();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);

  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  base = `http://localhost:${(httpServer.address() as { port: number }).port}`;
});

after(async () => {
  await getDb().dropDatabase();
  await closeDB();
  httpServer.close();
  await rm(uploadDir, { recursive: true, force: true });
});

describe('PUT /api/users/me/avatar: refused uploads', () => {
  let account: Account;
  before(async () => {
    account = await newAccount();
  });

  it('answers 401 without a token', async () => {
    const res = await fetch(`${base}/api/users/me/avatar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: png as RequestInit['body'],
    });
    assert.equal(res.status, 401);
  });

  it('answers 415 when the body is not sent as an image (JSON, or no body at all)', async () => {
    const asJson = await api('PUT', '/api/users/me/avatar', {}, bearer(account.token));
    assert.equal(asJson.status, 415);
    const empty = await api('PUT', '/api/users/me/avatar', undefined, bearer(account.token));
    assert.equal(empty.status, 415);
  });

  it('answers 400 when the bytes are not a PNG, JPEG or WebP, whatever the Content-Type says', async () => {
    const text = await upload(account, Buffer.from('this is not an image'));
    assert.equal(text.status, 400);
    const svg = await upload(account, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png');
    assert.equal(svg.status, 400);
    assert.equal(typeof (await svg.json()).error, 'string');
  });

  it('answers 413 above 2 MB', async () => {
    const tooBig = Buffer.concat([png, Buffer.alloc(MAX_AVATAR_BYTES)]);
    const res = await upload(account, tooBig);
    assert.equal(res.status, 413);
    assert.equal(typeof (await res.json()).error, 'string');
  });

  it('leaves the account without an avatar after all of these', async () => {
    const user = await me(account);
    assert.ok(!('avatarUrl' in user));
    assert.equal(user.hasCustomAvatar, false);
  });
});

describe('PUT /api/users/me/avatar: a valid picture', () => {
  let account: Account;
  let avatarUrl: string;
  before(async () => {
    account = await newAccount();
  });

  it('saves it on the server and answers with the updated user', async () => {
    const res = await upload(account, png);
    assert.equal(res.status, 200);
    const user = await res.json();
    avatarUrl = user.avatarUrl;
    assert.match(avatarUrl, new RegExp(`^/uploads/avatars/${account.id}-[0-9a-f]{16}\\.png$`));
    assert.equal(user.hasCustomAvatar, true);
    assert.ok(!('passwordHash' in user));
    assert.deepEqual(await readFile(fileOf(avatarUrl)), png);
  });

  it('keeps it: the profile shows it after a reload', async () => {
    const user = await me(account);
    assert.equal(user.avatarUrl, avatarUrl);
    assert.equal(user.hasCustomAvatar, true);
  });

  it('serves the file at /uploads with the same bytes, as an image, with nosniff', async () => {
    const res = await fetch(`${base}${avatarUrl}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  });

  it('answers 404 for a file that does not exist', async () => {
    const res = await fetch(`${base}/uploads/avatars/${account.id}-0000000000000000.png`);
    assert.equal(res.status, 404);
  });

  it('replaces the picture: the new file is saved and the old one deleted', async () => {
    const res = await upload(account, jpeg, 'image/jpeg');
    assert.equal(res.status, 200);
    const next = (await res.json()).avatarUrl as string;
    assert.notEqual(next, avatarUrl);
    assert.match(next, /\.jpg$/);
    assert.ok(existsSync(fileOf(next)));
    assert.ok(!existsSync(fileOf(avatarUrl)), 'the replaced file is deleted');
    avatarUrl = next;
  });

  it('chooses the extension from the bytes, not from the Content-Type', async () => {
    const res = await upload(account, webp, 'image/png'); // WebP bytes, but claimed to be a PNG
    assert.equal(res.status, 200);
    const next = (await res.json()).avatarUrl as string;
    assert.match(next, /\.webp$/);
    avatarUrl = next;
  });

  it('does not touch another account', async () => {
    const other = await newAccount();
    const user = await me(other);
    assert.ok(!('avatarUrl' in user));
  });
});

describe('DELETE /api/users/me/avatar', () => {
  it('answers 401 without a token', async () => {
    assert.equal((await api('DELETE', '/api/users/me/avatar')).status, 401);
  });

  it('removes the picture and its file', async () => {
    const account = await newAccount();
    const avatarUrl = (await (await upload(account, png)).json()).avatarUrl as string;
    assert.ok(existsSync(fileOf(avatarUrl)));

    const res = await removeAvatar(account);
    assert.equal(res.status, 200);
    const user = await res.json();
    assert.ok(!('avatarUrl' in user));
    assert.equal(user.hasCustomAvatar, false);
    assert.ok(!existsSync(fileOf(avatarUrl)));
    assert.ok(!('avatarUrl' in (await me(account))));
  });

  it('is fine when there is no picture to remove', async () => {
    const account = await newAccount();
    const res = await removeAvatar(account);
    assert.equal(res.status, 200);
    assert.ok(!('avatarUrl' in (await res.json())));
  });
});

describe('the Google picture is kept', () => {
  const googlePicture = 'https://lh3.googleusercontent.com/a/some-google-picture';
  const setInDb = (account: Account, fields: Record<string, string>) =>
    getDb().collection('users').updateOne({ email: account.email }, { $set: fields });

  it('is shown when there is no uploaded picture, and cannot be "removed"', async () => {
    const account = await newAccount();
    await setInDb(account, { googlePicture });
    const user = await me(account);
    assert.equal(user.avatarUrl, googlePicture);
    assert.equal(user.hasCustomAvatar, false);

    const removed = await (await removeAvatar(account)).json();
    assert.equal(removed.avatarUrl, googlePicture);
  });

  it('is replaced by an upload, and comes back when the upload is removed', async () => {
    const account = await newAccount();
    await setInDb(account, { googlePicture });

    const uploaded = await (await upload(account, png)).json();
    assert.match(uploaded.avatarUrl, /^\/uploads\/avatars\//);
    assert.equal(uploaded.hasCustomAvatar, true);

    const removed = await (await removeAvatar(account)).json();
    assert.equal(removed.avatarUrl, googlePicture);
    assert.equal(removed.hasCustomAvatar, false);
    assert.equal((await me(account)).avatarUrl, googlePicture);
  });

  it('is not lost for an older account that kept its Google link in avatarUrl', async () => {
    const account = await newAccount();
    await setInDb(account, { avatarUrl: googlePicture }); // how accounts were stored before googlePicture existed
    assert.equal((await me(account)).hasCustomAvatar, false);

    await upload(account, png);
    const removed = await (await removeAvatar(account)).json();
    assert.equal(removed.avatarUrl, googlePicture);
  });
});

describe('DELETE /api/users/me (account)', () => {
  it('also deletes the uploaded picture file', async () => {
    const account = await newAccount();
    const avatarUrl = (await (await upload(account, png)).json()).avatarUrl as string;
    assert.ok(existsSync(fileOf(avatarUrl)));

    const res = await api('DELETE', '/api/users/me', undefined, bearer(account.token));
    assert.equal(res.status, 200);
    assert.ok(!existsSync(fileOf(avatarUrl)));
    assert.equal((await fetch(`${base}${avatarUrl}`)).status, 404);
  });
});
