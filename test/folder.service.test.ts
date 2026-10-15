// Folder rules, tested against a real (test) MongoDB.
// Run with: npm run test:folder   (MongoDB must be running)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// Same safety rule as socket.test.ts: only ever touch a database named "...-test".
const testUri = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/sketch-space-test';
if (!/-test(\?|$)/.test(testUri))
  throw new Error(`Refusing to run: test database name must end in "-test" (got ${testUri})`);
process.env.MONGODB_URI = testUri;

const { connectDB, closeDB, getDb } = await import('../src/db.js');
const { createCanvas, findCanvas } = await import('../src/repositories/canvas.repository.js');
const { ensureFolderIndexes, findFolder } = await import('../src/repositories/folder.repository.js');
const { listCanvasesOf } = await import('../src/services/canvas.service.js');
const { createFolder, deleteFolder, deleteFoldersOfUser, listFoldersOf, moveCanvasToFolder, renameFolder } =
  await import('../src/services/folder.service.js');

const ALICE = 'a'.repeat(24);
const BOB = 'b'.repeat(24);
const UNKNOWN_ID = '6abe45dcc09e70d0e46e4bbb';

/** Creates a folder that must be accepted and returns its id. */
async function folder(userId: string, name: string): Promise<string> {
  const res = await createFolder(userId, name);
  assert.equal(res.ok, true, `could not create ${name}`);
  return res.ok ? res.folder.id : '';
}

const status = (r: { ok: boolean }) => (r.ok ? 200 : (r as unknown as { status: number }).status);

before(async () => {
  await connectDB();
  await getDb().dropDatabase();
  await ensureFolderIndexes();
});

after(async () => {
  await getDb().dropDatabase();
  await closeDB();
});

describe('createFolder', () => {
  // The stored name is trimmed; the wire shape has id, no _id and no owner.
  it('creates a folder with a trimmed name and returns it without the owner', async () => {
    const res = await createFolder(ALICE, '  Sketches  ');
    assert.equal(res.ok, true);
    const created = res.ok ? res.folder : null;
    assert.equal(created?.name, 'Sketches');
    assert.match(created?.id ?? '', /^[0-9a-f]{24}$/);
    assert.ok(created?.createdAt instanceof Date && created.updatedAt instanceof Date);
    assert.deepEqual(Object.keys(created ?? {}).sort(), ['createdAt', 'id', 'name', 'updatedAt']);
    assert.equal((await findFolder(created?.id ?? ''))?.ownerUserId, ALICE);
  });

  // 1-30 characters after trimming; an emoji counts as one character.
  it('accepts 1 to 30 characters and rejects empty, too long or non-string names (400)', async () => {
    assert.equal(status(await createFolder(ALICE, 'x')), 200);
    assert.equal(status(await createFolder(ALICE, 'y'.repeat(30))), 200);
    assert.equal(status(await createFolder(ALICE, '🎨'.repeat(30))), 200);
    for (const bad of ['', '   ', 'z'.repeat(31), 42, null, undefined, ['a'], { name: 'a' }])
      assert.deepEqual(await createFolder(ALICE, bad), {
        ok: false, status: 400, error: 'Folder name must be 1-30 characters',
      }, `should reject ${JSON.stringify(bad)}`);
  });

  // Unique per account, ignoring case and surrounding spaces; other accounts may reuse the name.
  it('refuses a name the account already has, ignoring case (409), but not another account\'s', async () => {
    await folder(ALICE, 'Work');
    for (const dup of ['Work', 'work', ' WORK '])
      assert.deepEqual(await createFolder(ALICE, dup), {
        ok: false, status: 409, error: 'A folder with this name already exists',
      });
    assert.equal(status(await createFolder(BOB, 'work')), 200);
  });
});

describe('listFoldersOf', () => {
  // Oldest first, and only the account's own folders.
  it('lists only the account\'s folders, oldest first', async () => {
    const user = 'c'.repeat(24);
    const first = await folder(user, 'B first');
    const second = await folder(user, 'A second');
    await folder(BOB, 'not theirs');
    assert.deepEqual((await listFoldersOf(user)).map((f) => f.id), [first, second]);
  });
});

describe('renameFolder', () => {
  it('renames the owner\'s folder, trims the name and bumps updatedAt', async () => {
    const id = await folder(ALICE, 'Old name');
    const before = await findFolder(id);
    await new Promise((r) => setTimeout(r, 5));
    const res = await renameFolder(id, ALICE, ' New name ');
    assert.equal(res.ok && res.folder.name, 'New name');
    assert.ok(res.ok && before && res.folder.updatedAt > before.updatedAt);
  });

  // Changing only the case of its own name is not a conflict with itself.
  it('lets a folder change the case of its own name', async () => {
    const id = await folder(ALICE, 'Case');
    const res = await renameFolder(id, ALICE, 'CASE');
    assert.equal(res.ok && res.folder.name, 'CASE');
  });

  it('refuses invalid ids (400), unknown folders (404), other accounts (403), bad names (400) and taken names (409)', async () => {
    const id = await folder(ALICE, 'Mine');
    await folder(ALICE, 'Taken');
    assert.equal(status(await renameFolder('nope', ALICE, 'x')), 400);
    assert.equal(status(await renameFolder(UNKNOWN_ID, ALICE, 'x')), 404);
    assert.deepEqual(await renameFolder(id, BOB, 'stolen'), { ok: false, status: 403, error: 'Not your folder' });
    assert.equal(status(await renameFolder(id, ALICE, '   ')), 400);
    assert.equal(status(await renameFolder(id, ALICE, 'taken')), 409);
    assert.equal((await findFolder(id))?.name, 'Mine', 'nothing changed');
  });
});

describe('moveCanvasToFolder', () => {
  it('moves the owner\'s canvas into their folder and out again (null)', async () => {
    const canvasId = await createCanvas({ name: 'to move' }, undefined, ALICE);
    const folderId = await folder(ALICE, 'Destination');

    assert.deepEqual(await moveCanvasToFolder(canvasId, folderId, ALICE), { ok: true });
    assert.equal((await findCanvas(canvasId))?.folderId, folderId);

    assert.deepEqual(await moveCanvasToFolder(canvasId, null, ALICE), { ok: true });
    assert.equal(await findCanvas(canvasId).then((c) => c && 'folderId' in c), false, 'the field is removed');
  });

  // A canvas is in at most one folder: moving it again replaces the folder.
  it('keeps a canvas in one folder at a time', async () => {
    const canvasId = await createCanvas({}, undefined, ALICE);
    const first = await folder(ALICE, 'First');
    const second = await folder(ALICE, 'Second');
    await moveCanvasToFolder(canvasId, first, ALICE);
    await moveCanvasToFolder(canvasId, second, ALICE);
    assert.equal((await findCanvas(canvasId))?.folderId, second);
  });

  it('refuses another account\'s canvas or folder (403), and token-only canvases (403)', async () => {
    const mine = await createCanvas({}, undefined, ALICE);
    const theirs = await createCanvas({}, undefined, BOB);
    const guest = await createCanvas({}, 'some-token-hash');
    const myFolder = await folder(ALICE, 'Private stuff');
    const theirFolder = await folder(BOB, 'Bob only');

    assert.deepEqual(await moveCanvasToFolder(theirs, myFolder, ALICE), {
      ok: false, status: 403, error: 'Only the owner can move this canvas',
    });
    assert.equal(status(await moveCanvasToFolder(guest, myFolder, ALICE)), 403);
    assert.deepEqual(await moveCanvasToFolder(mine, theirFolder, ALICE), { ok: false, status: 403, error: 'Not your folder' });
    assert.equal((await findCanvas(mine))?.folderId, undefined);
    assert.equal((await findCanvas(theirs))?.folderId, undefined);
  });

  it('reports invalid ids (400) and unknown canvases or folders (404)', async () => {
    const mine = await createCanvas({}, undefined, ALICE);
    assert.equal(status(await moveCanvasToFolder('nope', null, ALICE)), 400);
    assert.equal(status(await moveCanvasToFolder(42, null, ALICE)), 400);
    assert.equal(status(await moveCanvasToFolder(mine, 'nope', ALICE)), 400);
    assert.deepEqual(await moveCanvasToFolder(UNKNOWN_ID, null, ALICE), { ok: false, status: 404, error: 'Canvas not found' });
    assert.deepEqual(await moveCanvasToFolder(mine, UNKNOWN_ID, ALICE), { ok: false, status: 404, error: 'Folder not found' });
  });
});

describe('deleteFolder', () => {
  // The canvases stay; only their folderId goes, and other folders are untouched.
  it('deletes the folder, keeps its canvases and takes them out of it', async () => {
    const user = 'd'.repeat(24);
    const doomed = await folder(user, 'Doomed');
    const kept = await folder(user, 'Kept');
    const inDoomed = await createCanvas({ name: 'in doomed' }, undefined, user);
    const inKept = await createCanvas({ name: 'in kept' }, undefined, user);
    await moveCanvasToFolder(inDoomed, doomed, user);
    await moveCanvasToFolder(inKept, kept, user);

    assert.deepEqual(await deleteFolder(doomed, user), { ok: true });
    assert.equal(await findFolder(doomed), null);
    assert.equal((await findCanvas(inDoomed))?.name, 'in doomed', 'the canvas is kept');

    const listed = await listCanvasesOf(user);
    assert.deepEqual(
      listed.map((c) => [c.name, c.folderId]).sort(),
      [['in doomed', null], ['in kept', kept]],
    );
  });

  // The name is free again once the folder is gone.
  it('frees the name for a new folder', async () => {
    const id = await folder(ALICE, 'Reusable');
    await deleteFolder(id, ALICE);
    assert.equal(status(await createFolder(ALICE, 'reusable')), 200);
  });

  it('refuses invalid ids (400), unknown folders (404) and other accounts (403), and deletes nothing', async () => {
    const id = await folder(ALICE, 'Not for Bob');
    assert.equal(status(await deleteFolder('nope', ALICE)), 400);
    assert.equal(status(await deleteFolder(UNKNOWN_ID, ALICE)), 404);
    assert.equal(status(await deleteFolder(id, BOB)), 403);
    assert.ok(await findFolder(id));
  });
});

describe('listCanvasesOf and folders', () => {
  // Every canvas carries folderId; null when it is in no folder.
  it('includes folderId on every canvas, null when in no folder', async () => {
    const user = 'e'.repeat(24);
    const folderId = await folder(user, 'Box');
    const inside = await createCanvas({ name: 'inside' }, undefined, user);
    await createCanvas({ name: 'outside' }, undefined, user);
    await moveCanvasToFolder(inside, folderId, user);

    const byName = Object.fromEntries((await listCanvasesOf(user)).map((c) => [c.name, c.folderId]));
    assert.deepEqual(byName, { inside: folderId, outside: null });
  });
});

describe('deleteFoldersOfUser', () => {
  it('deletes every folder of the account and no one else\'s', async () => {
    const user = 'f'.repeat(24);
    await folder(user, 'One');
    await folder(user, 'Two');
    const bobs = await folder(BOB, 'Survivor');
    assert.equal(await deleteFoldersOfUser(user), 2);
    assert.deepEqual(await listFoldersOf(user), []);
    assert.ok(await findFolder(bobs));
  });
});
