// Element rules shared by REST and sockets: one way to add, change and delete an element (and tell
// the canvas about it) and one wire shape for elements.
import { findCanvas } from '../repositories/canvas.repository.js';
import {
  addElement as insertElement,
  deleteElement as removeElement,
  listElements,
  updateElement as changeElement,
} from '../repositories/element.repository.js';
import type { ElementDoc, ElementUpdate, NewElement } from '../models/element.model.js';
import { isValidCanvasId } from '../validation/canvas.validation.js';
import { canvasEvents } from './canvas.events.js';

/** An element as clients see it, over REST and sockets alike: its fields plus `id` (no _id). */
export type ElementMessage = Omit<ElementDoc, '_id'> & { id: string };

export function toElementMessage({ _id, ...rest }: ElementDoc): ElementMessage {
  return { ...rest, id: _id.toString() };
}

/** All elements of a canvas, oldest first. */
export async function listElementMessages(canvasId: string): Promise<ElementMessage[]> {
  return (await listElements(canvasId)).map(toElementMessage);
}

/** Why a request was refused. `status` is the matching HTTP status for REST handlers. */
export type ElementFailure = { ok: false; status: 400 | 404; error: string };

/** Checks the ids and that the canvas still exists. */
async function checkCanvas(canvasId: string, elementId?: string): Promise<ElementFailure | null> {
  if (!isValidCanvasId(canvasId)) return { ok: false, status: 400, error: 'Invalid canvas id' };
  if (elementId !== undefined && !isValidCanvasId(elementId)) // element ids have the same format
    return { ok: false, status: 400, error: 'Invalid element id' };
  if (!(await findCanvas(canvasId))) return { ok: false, status: 404, error: 'Canvas not found' };
  return null;
}

/**
 * Saves an element, then pushes it to everyone in the canvas except the sender (who already has
 * it). Used by both the socket handler and the REST endpoint.
 */
export async function addElement(
  element: NewElement,
  senderSocketId?: string,
): Promise<{ ok: true; id: string } | ElementFailure> {
  const refused = await checkCanvas(element.canvasId);
  if (refused) return refused;

  // save first, so anything others see is already stored
  const message = toElementMessage(await insertElement(element));
  canvasEvents.emit('elementAdded', message, senderSocketId);
  return { ok: true, id: message.id };
}

/** Applies a partial change (last write wins) and pushes the element's new state to the others. */
export async function updateElement(
  canvasId: string,
  elementId: string,
  changes: ElementUpdate,
  senderSocketId?: string,
): Promise<{ ok: true } | ElementFailure> {
  const refused = await checkCanvas(canvasId, elementId);
  if (refused) return refused;

  const updated = await changeElement(canvasId, elementId, changes);
  if (!updated) return { ok: false, status: 404, error: 'Element not found' };
  canvasEvents.emit('elementUpdated', toElementMessage(updated), senderSocketId);
  return { ok: true };
}

/** Deletes an element and tells the others. */
export async function deleteElement(
  canvasId: string,
  elementId: string,
  senderSocketId?: string,
): Promise<{ ok: true } | ElementFailure> {
  const refused = await checkCanvas(canvasId, elementId);
  if (refused) return refused;

  if (!(await removeElement(canvasId, elementId))) return { ok: false, status: 404, error: 'Element not found' };
  canvasEvents.emit('elementDeleted', canvasId, elementId, senderSocketId);
  return { ok: true };
}
