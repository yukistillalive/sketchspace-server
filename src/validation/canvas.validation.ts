import type { CanvasUpdate } from '../models/canvas.model.js';

export const isValidCanvasId = (id: string): boolean => /^[0-9a-f]{24}$/i.test(id);

/** Picks and type-checks the writable canvas fields; returns null if any is the wrong type. */
export function parseCanvasBody(body: unknown): CanvasUpdate | null {
  const { name, isShared } = (body ?? {}) as Record<string, unknown>;
  if (name !== undefined && typeof name !== 'string') return null;
  if (isShared !== undefined && typeof isShared !== 'boolean') return null;
  return { name, isShared };
}
