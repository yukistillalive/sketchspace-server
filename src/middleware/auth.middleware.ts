import type { Request, RequestHandler, Response } from 'express';
import { TOKEN_TTL_SECONDS, verifyToken } from '../services/auth.service.js';

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

/** The owner token the client proves canvas ownership with (returned once by POST /api/canvas). */
export const ownerTokenOf = (req: Request): string | undefined => req.header('x-owner-token');

/** The logged-in user's id for canvas rules, undefined for a guest. */
export const userIdOf = (req: Request): string | undefined => optionalUserId(req) ?? undefined;

const isProduction = process.env.NODE_ENV === 'production';

// httpOnly: not readable from JavaScript. In production the frontend is on another origin,
// so the cookie must be sameSite=none (which requires https / secure).
const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? ('none' as const) : ('lax' as const),
  path: '/',
};

/** Stores the login token in the httpOnly cookie. */
export const setSessionCookie = (res: Response, token: string): void => {
  res.cookie(TOKEN_COOKIE, token, { ...cookieOptions, maxAge: TOKEN_TTL_SECONDS * 1000 });
};

export const clearSessionCookie = (res: Response): void => {
  res.clearCookie(TOKEN_COOKIE, cookieOptions);
};
