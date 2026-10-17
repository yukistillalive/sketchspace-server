import type { WithId } from 'mongodb';

export interface Layer {
  id: string;
  order: number;
  visible: boolean;
}

export interface Canvas {
  name: string;
  /** A shared canvas can be joined by other users; an unshared one is private. */
  isShared: boolean;
  createdAt: Date;
  updatedAt: Date;
  layers: Layer[];
  /** SHA-256 of the owner token. Absent on canvases created before owners existed. Never sent to clients. */
  ownerTokenHash?: string;
  /** The account that created the canvas while logged in. Never sent to clients. */
  ownerUserId?: string;
  /** The owner's folder the canvas is in; absent = in no folder. Only sent to the owner. */
  folderId?: string;
}

//the layer at the forefront starts with 0, layers behind it will be numbered > 0. (order 1 is behind order 0)
export const DEFAULT_LAYERS: Layer[] = [{id: "foreground", order: 0, visible: true}, 
{id: "middleground", order: 1, visible: true}, {id: "background", order: 2, visible: true}
]

export type CanvasDoc = WithId<Canvas>;
/**
 * A canvas as sent to clients: everything except the owner token hash, the owner account and the
 * folder (folders are private to the owner).
 */
export type PublicCanvas = Omit<CanvasDoc, 'ownerTokenHash' | 'ownerUserId' | 'folderId'>;

export function toPublicCanvas({
  ownerTokenHash: _hash,
  ownerUserId: _user,
  folderId: _folder,
  ...rest
}: CanvasDoc): PublicCanvas {
  return rest;
}

/** A canvas as sent to its owner: the public view plus its folder (null = in no folder). */
export type OwnedCanvas = PublicCanvas & { folderId: string | null };

export const toOwnedCanvas = (doc: CanvasDoc): OwnedCanvas => ({ ...toPublicCanvas(doc), folderId: doc.folderId ?? null });

export interface NewCanvas {
  name?: string;
  isShared?: boolean;
}

export type CanvasUpdate = NewCanvas;
