import { Router } from 'express';
import { clearSessionCookie, optionalUserId, setSessionCookie } from '../middleware/auth.middleware.js';
import { getSessionUser, login, loginWithGoogle, register } from '../services/user.service.js';

export const authRouter = Router();

// POST /api/auth/register  { email, password, displayName }
authRouter.post('/register', async (req, res) => {
  const result = await register(req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  setSessionCookie(res, result.token);
  res.status(201).json({ user: result.user, token: result.token });
});

// POST /api/auth/login  { email, password }
authRouter.post('/login', async (req, res) => {
  const result = await login(req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  setSessionCookie(res, result.token);
  res.json({ user: result.user, token: result.token });
});

// POST /api/auth/google  { idToken }   (idToken = the "credential" from Google Identity Services)
authRouter.post('/google', async (req, res) => {
  const result = await loginWithGoogle(req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  setSessionCookie(res, result.token);
  res.status(result.created ? 201 : 200).json({ user: result.user, token: result.token });
});

// GET /api/auth/session  ->  { user } for a logged-in user, { user: null } for a guest.
// The frontend asks this every time it opens. A guest gets 200 here (GET /api/users/me would answer 401),
// so the browser does not print a red error in the console on every visit of someone who is not logged in.
authRouter.get('/session', async (req, res) => {
  res.json({ user: await getSessionUser(optionalUserId(req)) });
});

// POST /api/auth/logout  (clears the cookie; a copy of the token stays valid until it expires)
authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
