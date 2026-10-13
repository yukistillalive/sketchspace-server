import { Router } from 'express';
import { authUserId, requireAuth } from '../middleware/auth.middleware.js';
import { clearSessionCookie } from '../routes/auth.routes.js';
import * as repo from '../repositories/user.repository.js';
import { deleteCanvasesOfUser } from '../services/canvas.service.js';
import { isValidAvatarUrl, isValidDisplayName } from '../validation/auth.validation.js';

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

// DELETE /api/users/me
// (also deletes the canvases the account owns, with their strokes and elements)
userRouter.delete('/me', async (_req, res) => {
  const found = await repo.deleteUser(authUserId(res));
  if (found) await deleteCanvasesOfUser(authUserId(res));
  if (!found) return res.status(401).json({ error: 'Account no longer exists' });
  clearSessionCookie(res);
  res.json({ ok: true });
});
