/** True for the error MongoDB throws when a unique index is violated. */
export const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
