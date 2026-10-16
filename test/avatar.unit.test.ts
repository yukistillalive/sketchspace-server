// Pure tests for the avatar file handling: no database, no server (files go to a temporary folder).
// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'sketchspace-avatar-unit-'));
process.env.UPLOAD_DIR = uploadDir; // avatar.service.ts reads this when first imported

const { AVATAR_MIME_TYPES, MAX_AVATAR_BYTES, deleteAvatarFile, detectImageType, saveAvatarFile } = await import(
  '../src/services/avatar.service.js'
);

const userId = '6abe45dcc09e70d0e46e4bbb';
const avatarsDir = path.join(uploadDir, 'avatars');
const fileOf = (avatarUrl: string): string => path.join(avatarsDir, path.basename(avatarUrl));

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);

after(async () => {
  await rm(uploadDir, { recursive: true, force: true });
});

describe('limits', () => {
  it('allows PNG, JPEG and WebP up to 2 MB', () => {
    assert.deepEqual(AVATAR_MIME_TYPES, ['image/png', 'image/jpeg', 'image/webp']);
    assert.equal(MAX_AVATAR_BYTES, 2 * 1024 * 1024);
  });
});

describe('detectImageType (looks at the bytes, not at what the client claims)', () => {
  it('recognises PNG, JPEG and WebP', () => {
    assert.equal(detectImageType(png), 'png');
    assert.equal(detectImageType(jpeg), 'jpg');
    assert.equal(detectImageType(webp), 'webp');
  });

  it('refuses everything else: SVG, GIF, other RIFF files, text, empty and truncated data', () => {
    const notAllowed = [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      Buffer.from('GIF89a' + 'x'.repeat(20)),
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)]),
      Buffer.from('just some text pretending to be a picture'),
      Buffer.alloc(0),
      png.subarray(0, 4),
      jpeg.subarray(0, 2),
    ];
    for (const data of notAllowed) assert.equal(detectImageType(data), null, data.subarray(0, 12).toString('latin1'));
  });
});

describe('saveAvatarFile', () => {
  it('writes the file under /uploads/avatars with a name made of the user id, random hex and extension', async () => {
    const avatarUrl = await saveAvatarFile(userId, png, 'png');
    assert.match(avatarUrl, new RegExp(`^/uploads/avatars/${userId}-[0-9a-f]{16}\\.png$`));
    assert.deepEqual(await readFile(fileOf(avatarUrl)), png);
  });

  it('gives every upload a new name, so browsers never show an older cached picture', async () => {
    const first = await saveAvatarFile(userId, jpeg, 'jpg');
    const second = await saveAvatarFile(userId, jpeg, 'jpg');
    assert.notEqual(first, second);
    assert.match(first, /\.jpg$/);
  });
});

describe('deleteAvatarFile', () => {
  it('deletes the file of an uploaded avatar, and does not fail when it is already gone', async () => {
    const avatarUrl = await saveAvatarFile(userId, webp, 'webp');
    assert.ok(existsSync(fileOf(avatarUrl)));
    await deleteAvatarFile(avatarUrl);
    assert.ok(!existsSync(fileOf(avatarUrl)));
    await deleteAvatarFile(avatarUrl); // second time: nothing to delete, no error
  });

  it('does nothing for a Google link, an empty value or an unknown shape', async () => {
    await deleteAvatarFile('https://lh3.googleusercontent.com/a/some-picture');
    await deleteAvatarFile(undefined);
    await deleteAvatarFile(null);
    await deleteAvatarFile('');
  });

  it('never deletes anything outside the avatars folder or not named by this service', async () => {
    const secret = path.join(uploadDir, 'secret.txt');
    await writeFile(secret, 'keep me');
    await mkdir(avatarsDir, { recursive: true });
    const stranger = path.join(avatarsDir, 'stranger.png'); // in the right folder, but not a name this service makes
    await writeFile(stranger, 'keep me too');

    await deleteAvatarFile('/uploads/avatars/../secret.txt');
    await deleteAvatarFile('/uploads/avatars/../../secret.txt');
    await deleteAvatarFile('/uploads/avatars/stranger.png');
    await deleteAvatarFile(`/uploads/avatars/${userId}-0123456789abcdef.png/../../../secret.txt`);

    assert.ok(existsSync(secret));
    assert.ok(existsSync(stranger));
  });
});
