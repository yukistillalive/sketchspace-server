import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where uploaded files live. Defaults to <server folder>/uploads (next to public/).
 * In Docker this folder is a volume, so pictures survive a container restart.
 */
export const UPLOAD_ROOT = process.env.UPLOAD_DIR ?? fileURLToPath(new URL('../../uploads', import.meta.url));
const AVATAR_DIR = path.join(UPLOAD_ROOT, 'avatars');

/** The avatarUrl of an uploaded picture is a path on this server: /uploads/avatars/<file>. */
const AVATAR_URL_PREFIX = '/uploads/avatars/';

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export type AvatarExtension = 'png' | 'jpg' | 'webp';

export function detectImageType(data: Buffer): AvatarExtension | null {
  const isPng =
    data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (isPng) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP')
    return 'webp';
  return null;
}

/** Writes the picture to disk under a new random name and returns its avatarUrl. */
export async function saveAvatarFile(userId: string, data: Buffer, extension: AvatarExtension): Promise<string> {
  await mkdir(AVATAR_DIR, { recursive: true });
  // a new name for every upload: browsers never show a cached older picture
  const fileName = `${userId}-${randomBytes(8).toString('hex')}.${extension}`;
  await writeFile(path.join(AVATAR_DIR, fileName), data);
  return AVATAR_URL_PREFIX + fileName;
}

// only names this service makes are ever deleted (no "..", no other folders)
const OWN_AVATAR_RE = /^\/uploads\/avatars\/([0-9a-f]{24}-[0-9a-f]{16}\.(?:png|jpg|webp))$/;

// Deletes the file behind an avatarUrl. Does nothing for other links (e.g. a Google picture) or a missing file. */
export async function deleteAvatarFile(avatarUrl: string | undefined | null): Promise<void> {
  const fileName = avatarUrl ? OWN_AVATAR_RE.exec(avatarUrl)?.[1] : undefined;
  if (!fileName) return;
  try {
    await unlink(path.join(AVATAR_DIR, fileName));
  } catch {}
}
