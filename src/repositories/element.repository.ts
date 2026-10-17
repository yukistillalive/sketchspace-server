import { ObjectId, type Collection } from 'mongodb';
import { getDb } from '../db.js';
import type { CanvasElement, ElementDoc, ElementUpdate, NewElement } from '../models/element.model.js';

const elements = (): Collection<CanvasElement> => getDb().collection<CanvasElement>('elements');

export async function addElement(element: NewElement): Promise<ElementDoc> {
  const now = new Date();
  const doc = { ...element, createdAt: now, updatedAt: now };
  const result = await elements().insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** One element of a canvas, or null (also when it belongs to another canvas). */
export function getElement(canvasId: string, id: string): Promise<ElementDoc | null> {
  return elements().findOne({ _id: new ObjectId(id), canvasId });
}

/** All elements of a canvas, oldest first. */
export function listElements(canvasId: string): Promise<ElementDoc[]> {
  return elements().find({ canvasId }).sort({ createdAt: 1, _id: 1 }).toArray();
}

/** Applies only the fields that are present and sets updatedAt. Returns the updated element, or null. */
export function updateElement(canvasId: string, id: string, changes: ElementUpdate): Promise<ElementDoc | null> {
  return elements().findOneAndUpdate(
    { _id: new ObjectId(id), canvasId },
    { $set: { ...changes, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/** Returns false if no such element exists in the canvas. */
export async function deleteElement(canvasId: string, id: string): Promise<boolean> {
  const result = await elements().deleteOne({ _id: new ObjectId(id), canvasId });
  return result.deletedCount > 0;
}

/** Removes every element of a canvas. Returns how many were deleted. */
export async function deleteElementsByCanvas(canvasId: string): Promise<number> {
  const result = await elements().deleteMany({ canvasId });
  return result.deletedCount;
}
