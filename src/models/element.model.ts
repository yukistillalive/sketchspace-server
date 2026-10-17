import type { WithId } from 'mongodb';

export type ElementType = 'shape' | 'photo' | 'cutout';

/** Position, size and rotation of something placed on the canvas. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface CanvasElement extends Box {
  canvasId: string;
  type: ElementType;
  zIndex: number;
  // shape
  shape?: string;
  /** null = dashed template (not filled in yet) */
  color?: string | null;
  // photo and cutout: the Unsplash URL, not the image itself
  url?: string;
  photographer?: string;
  photographerLink?: string;
  // cutout: the size of the hole and where the photo sits behind it
  cutWidth?: number;
  cutHeight?: number;
  photo?: Box;
  createdAt: Date;
  updatedAt: Date;
}

export type ElementDoc = WithId<CanvasElement>;
export type NewElement = Omit<CanvasElement, 'createdAt' | 'updatedAt'>;
/** The fields a client may change after creation (not which canvas or which type). */
export type ElementUpdate = Partial<Omit<NewElement, 'canvasId' | 'type'>>;
