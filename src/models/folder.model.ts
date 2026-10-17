import type { WithId } from 'mongodb';

export interface Folder {
  /** The account the folder belongs to. Never sent to clients. */
  ownerUserId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export type FolderDoc = WithId<Folder>;

/** A folder as sent to clients: `id` instead of _id, and no owner (it is always the caller). */
export interface PublicFolder {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export const toPublicFolder = ({ _id, name, createdAt, updatedAt }: FolderDoc): PublicFolder => ({
  id: _id.toString(),
  name,
  createdAt,
  updatedAt,
});
