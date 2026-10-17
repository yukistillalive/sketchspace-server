// Shared by the REST element endpoints and the socket handlers, so both enforce the same limits.
import type { Box, ElementType, ElementUpdate, NewElement } from '../repositories/element.repository.js';

const ELEMENT_TYPES: readonly ElementType[] = ['shape', 'photo', 'cutout'];
export const SHAPES = [
  'rectangle', 'square', 'circle', 'ellipse', 'triangle', 'diamond',
  'pentagon', 'hexagon', 'star', 'heart', 'line', 'arrow',
] as const;

const MAX_COORD = 100_000; // x / y
const MAX_SIZE = 20_000; // width / height
const MAX_ROTATION = 36_000; // degrees, so a few hundred full turns at most
const MAX_Z_INDEX = 1_000_000;
const MAX_NAME = 200;
const MAX_COLOR = 64;
const MAX_URL = 2048;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const inRange = (min: number, max: number) => (v: unknown) => isNum(v) && v >= min && v <= max;
const size = (v: unknown) => isNum(v) && v > 0 && v <= MAX_SIZE;
const text = (max: number) => (v: unknown) => isStr(v) && v.length <= max;
/** Links are rendered by clients, so only https is accepted (no javascript: or data: URLs). */
const httpsUrl = (v: unknown) => {
  if (!isStr(v) || v.length > MAX_URL) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

const isBox = (v: unknown): v is Box =>
  typeof v === 'object' && v !== null && BOX_CHECKS.every(([key, ok]) => ok((v as Record<string, unknown>)[key]));

const BOX_CHECKS: [keyof Box, (v: unknown) => boolean][] = [
  ['x', inRange(-MAX_COORD, MAX_COORD)],
  ['y', inRange(-MAX_COORD, MAX_COORD)],
  ['width', size],
  ['height', size],
  ['rotation', inRange(-MAX_ROTATION, MAX_ROTATION)],
];

/** Fields every element has, and the check each value must pass. */
const BASE: Record<string, (v: unknown) => boolean> = {
  ...Object.fromEntries(BOX_CHECKS),
  zIndex: inRange(-MAX_Z_INDEX, MAX_Z_INDEX),
};

/** Extra fields per type, with the check each value must pass. */
const isShapeName = (v: unknown) => (SHAPES as readonly unknown[]).includes(v);
const EXTRA: Record<ElementType, Record<string, (v: unknown) => boolean>> = {
  shape: {
    shape: isShapeName,
    color: (v) => v === null || text(MAX_COLOR)(v),
  },
  photo: { url: httpsUrl, photographer: text(MAX_NAME), photographerLink: httpsUrl },
  cutout: {
    shape: isShapeName, url: httpsUrl, photographer: text(MAX_NAME), photographerLink: httpsUrl,
    cutWidth: size, cutHeight: size, photo: isBox,
  },
};

const REQUIRED: Record<ElementType, string[]> = {
  shape: ['shape'],
  photo: ['url'],
  cutout: ['shape', 'url', 'cutWidth', 'cutHeight', 'photo'],
};

const ALL_UPDATABLE: Record<string, (v: unknown) => boolean> = ELEMENT_TYPES.reduce(
  (all, t) => ({ ...all, ...EXTRA[t] }),
  BASE,
);

const isType = (v: unknown): v is ElementType => (ELEMENT_TYPES as readonly unknown[]).includes(v);

/** Copies the fields in `checks` that are present, or null if one fails its check. */
function pick(s: Record<string, unknown>, checks: Record<string, (v: unknown) => boolean>): Record<string, unknown> | null {
  const present = Object.entries(checks).filter(([key]) => s[key] !== undefined);
  if (!present.every(([key, ok]) => ok(s[key]))) return null;
  return Object.fromEntries(present.map(([key]) => [key, key === 'photo' ? pickBox(s[key] as Box) : s[key]]));
}

const pickBox = ({ x, y, width, height, rotation }: Box): Box => ({ x, y, width, height, rotation });

/** Clients are untrusted: check the shape and size of everything we persist and relay. */
export function parseElement(raw: unknown): NewElement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!isStr(s.canvasId) || !isType(s.type)) return null;

  // base fields are all required, then the type's own fields
  const base = pick(s, BASE);
  if (!base || Object.keys(base).length !== Object.keys(BASE).length) return null;
  const extra = pick(s, EXTRA[s.type]);
  if (!extra || !REQUIRED[s.type].every((key) => extra[key] !== undefined)) return null;

  // rebuilt from checked fields so unknown extra fields are dropped
  return { canvasId: s.canvasId, type: s.type, ...base, ...extra } as NewElement;
}

/** A partial change: any subset of the editable fields, at least one. Null if empty or invalid. */
export function parseElementUpdate(raw: unknown): ElementUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const changes = pick(raw as Record<string, unknown>, ALL_UPDATABLE);
  if (!changes || Object.keys(changes).length === 0) return null;
  return changes as ElementUpdate;
}
