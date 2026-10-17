import express, { Router } from 'express';
import { authUserId, clearSessionCookie, requireAuth } from '../middleware/auth.middleware.js';
import {
  deleteAccount,
  getProfile,
  removeAvatar,
  updateProfile,
  uploadAvatar,
} from '../services/user.service.js';

export const userRouter = Router();

userRouter.use(requireAuth);

// GET /api/users/me
userRouter.get('/me', async (_req, res) => {
  const result = await getProfile(authUserId(res));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

// PUT /api/users/me  { displayName?, avatarUrl? (https URL or png/jpeg/webp base64 data URL up to 200KB, or null to remove) }
userRouter.put('/me', async (req, res) => {
  const result = await updateProfile(authUserId(res), req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

// The picture itself is the request body (not JSON), so it is read as raw bytes. Anything bigger than the
// limit is refused with 413.
const readImageBody = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: 2 * 1024 * 1024 }); // 2 MB

// PUT /api/users/me/avatar   body: the image file, Content-Type image/png | image/jpeg | image/webp (max 2 MB)
// Saves the file on the server and makes it the account's avatar. Returns the updated user.
userRouter.put('/me/avatar', readImageBody, async (req, res) => {
  const result = await uploadAvatar(authUserId(res), req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

// DELETE /api/users/me/avatar
// Removes the uploaded picture (and its file). The Google picture, if the account has one, is shown again.
// Returns the updated user.
userRouter.delete('/me/avatar', async (_req, res) => {
  const result = await removeAvatar(authUserId(res));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

// DELETE /api/users/me
// (also deletes the canvases the account owns, with their strokes and elements, its folders and its uploaded avatar)
userRouter.delete('/me', async (_req, res) => {
  const result = await deleteAccount(authUserId(res));
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  clearSessionCookie(res);
  res.json({ ok: true });
});
