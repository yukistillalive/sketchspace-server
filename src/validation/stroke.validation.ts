// Shared by the REST stroke endpoint and the socket handler, so both enforce the same limits.
import type { NewStroke } from '../repositories/stroke.repository.js';

const MAX_POINTS_PER_STROKE = 5000; // caps the size of one saved stroke

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Clients are untrusted: check the shape and size of everything we persist and relay. */
export function parseStroke(raw: unknown): NewStroke | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;

  // required text fields, then numeric ranges, then the path
  if (!isStr(s.canvasId) || !isStr(s.layerId) || !isStr(s.brush) || !isStr(s.color)) return null;
  if (!isNum(s.size) || s.size <= 0 || s.size > 500) return null;
  if (!isNum(s.opacity) || s.opacity < 0 || s.opacity > 1) return null;
  if (!Array.isArray(s.path) || s.path.length === 0 || s.path.length > MAX_POINTS_PER_STROKE)
    return null;
  if (!s.path.every((p) => typeof p === 'object' && p !== null && isNum(p.x) && isNum(p.y)))
    return null;

  // rebuild the object from checked fields so unknown extra fields are dropped
  return {
    canvasId: s.canvasId,
    layerId: s.layerId,
    brush: s.brush,
    color: s.color,
    size: s.size,
    opacity: s.opacity,
    path: s.path.map((p: { x: number; y: number }) => ({ x: p.x, y: p.y })),
  };
}
