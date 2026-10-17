import type { Request, RequestHandler, Response } from 'express';
import { verifyToken } from '../services/auth.service.js';

/** Name of the httpOnly cookie that carries the JWT. */
export const TOKEN_COOKIE = 'token';

const BEARER_RE = /^Bearer (\S+)$/i;

/** The token comes from the Authorization header, or else from the cookie. */
function extractToken(req: Request): string | null {
  const bearer = req.headers.authorization ? BEARER_RE.exec(req.headers.authorization)?.[1] : undefined;
  if (bearer) return bearer;
  const cookie: unknown = req.cookies?.[TOKEN_COOKIE];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null;
}

/**
 * The id of the logged-in user, or null for a guest. Never refuses the request: routes that work
 * for guests too (like creating a canvas) use this instead of requireAuth.
 */
export function optionalUserId(req: Request): string | null {
  const token = extractToken(req);
  return token ? verifyToken(token) : null;
}

/** Same for a socket: reads the login cookie sent with the connection. */
export function userIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  const pair = cookieHeader?.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${TOKEN_COOKIE}=`));
  const value = pair ? decodeURIComponent(pair.slice(TOKEN_COOKIE.length + 1)) : '';
  return value ? verifyToken(value) : null;
}

/**
 * Protects a route: the token is VERIFIED (signature + expiry), not just read.
 * On success the user id is available through authUserId(res).
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });

  // res.locals is Express's place for per-request state; later handlers read it via authUserId(res).
  res.locals.userId = userId;
  next();
};

/** The id of the signed-in user. Only call it in handlers behind requireAuth. */
export const authUserId = (res: Response): string => res.locals.userId as string;
