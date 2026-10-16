import express, { Router } from 'express';
import { authUserId, requireAuth } from '../middleware/auth.middleware.js';
import { clearSessionCookie } from '../routes/auth.routes.js';
import * as repo from '../repositories/user.repository.js';
import { deleteCanvasesOfUser } from '../services/canvas.service.js';
import { deleteFoldersOfUser } from '../services/folder.service.js';
import { isValidAvatarUrl, isValidDisplayName } from '../validation/auth.validation.js';
import {deleteAvatarFile,detectImageType,saveAvatarFile } from '../services/avatar.service.js';

export const userRouter = Router();

userRouter.use(requireAuth);

function parseBody(body: unknown): repo.UserUpdate | null {
  const { displayName, avatarUrl } = (body ?? {}) as Record<string, unknown>;
  if (displayName !== undefined && !isValidDisplayName(displayName)) return null;
  if (avatarUrl !== undefined && avatarUrl !== null && !isValidAvatarUrl(avatarUrl)) return null;
  return { displayName, avatarUrl } as repo.UserUpdate;
}

// GET /api/users/me
userRouter.get('/me', async (_req, res) => {
  const user = await repo.findUserById(authUserId(res));
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json(repo.toPublicUser(user));
});

// PUT /api/users/me  { displayName?, avatarUrl? (string, or null to remove) }
userRouter.put('/me', async (req, res) => {
  const body = parseBody(req.body);
  if (!body || (body.displayName === undefined && body.avatarUrl === undefined))
    return res.status(400).json({
      error: 'Provide displayName (2-30 characters) and/or avatarUrl (https URL or null)',
    });

  const user = await repo.updateUser(authUserId(res), body);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json(repo.toPublicUser(user));
});

// The picture itself is the request body (not JSON), so it is read as raw bytes. Anything bigger than the
// limit is refused with 413.
const readImageBody = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: 2 * 1024 * 1024 }); // 2 MB });

// PUT /api/users/me/avatar   body: the image file, Content-Type image/png | image/jpeg | image/webp (max 2 MB)
// Saves the file on the server and makes it the account's avatar. Returns the updated user.
userRouter.put('/me/avatar', readImageBody, async (req, res) => {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0)
    return res.status(415).json({ error: 'Send the image as the request body (image/png, image/jpeg or image/webp)' });
  const image: Buffer = body;

  const extension = detectImageType(image);
  if (!extension) return res.status(400).json({ error: 'The file is not a valid PNG, JPEG or WebP image' });

  const userId = authUserId(res);
  const before = await repo.findUserById(userId);
  if (!before) return res.status(401).json({ error: 'Account no longer exists' });

  const avatarUrl = await saveAvatarFile(userId, image, extension);
  const user = await repo.updateUser(userId, { avatarUrl });
  // older accounts kept their Google picture in avatarUrl: remember it before it is replaced, so it can come back
  if (user && before.avatarUrl && !repo.isUploadedAvatar(before.avatarUrl) && !before.googlePicture)
    await repo.setGooglePicture(userId, before.avatarUrl);
  if (!user) {
    await deleteAvatarFile(avatarUrl); // the account was deleted meanwhile
    return res.status(401).json({ error: 'Account no longer exists' });
  }
  await deleteAvatarFile(before.avatarUrl); // the picture it replaces
  const current = await repo.findUserById(userId);
  res.json(repo.toPublicUser(current ?? user));
});

// DELETE /api/users/me/avatar
// Removes the uploaded picture (and its file). The Google picture, if the account has one, is shown again.
// Returns the updated user.
userRouter.delete('/me/avatar', async (_req, res) => {
  const userId = authUserId(res);
  const before = await repo.findUserById(userId);
  if (!before) return res.status(401).json({ error: 'Account no longer exists' });

  const user = await repo.updateUser(userId, { avatarUrl: null });
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  await deleteAvatarFile(before.avatarUrl);
  res.json(repo.toPublicUser(user));
});

// DELETE /api/users/me
// (also deletes the canvases the account owns, with their strokes and elements, its folders and its uploaded avatar)
userRouter.delete('/me', async (_req, res) => {
  const before = await repo.findUserById(authUserId(res));
  const found = await repo.deleteUser(authUserId(res));
  if (found) await deleteAvatarFile(before?.avatarUrl);
  if (found) await deleteCanvasesOfUser(authUserId(res));
  if (found) await deleteFoldersOfUser(authUserId(res));
  if (!found) return res.status(401).json({ error: 'Account no longer exists' });
  clearSessionCookie(res);
  res.json({ ok: true });
});
