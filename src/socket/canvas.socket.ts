// Real-time layer. A canvas is a sketching room: sockets join it by canvas id, finished
// strokes and placed elements are saved and relayed to everyone else in the room.
import type { Server, Socket } from 'socket.io';
import { canvasEvents } from '../services/canvas.events.js';
import { clearCanvasStrokes, getAccessibleCanvas } from '../services/canvas.service.js';
import { userIdFromCookieHeader } from '../middleware/auth.middleware.js';
import {
  addElement,
  deleteElement,
  listElementMessages,
  updateElement,
  type ElementMessage,
} from '../services/element.service.js';
import {
  deleteStrokeById,
  listStrokeMessages,
  saveStroke,
  undoLastStroke,
  type Sender,
  type StrokeMessage,
} from '../services/stroke.service.js';
import type { ElementUpdate, NewElement } from '../models/element.model.js';
import type { NewStroke } from '../models/stroke.model.js';
import { parseElement, parseElementUpdate } from '../validation/element.validation.js';
import { parseStroke } from '../validation/stroke.validation.js';

// Every client request gets an acknowledgement: { ok: true, ...data } or { ok: false, error }.
type Ack<T> = (result: ({ ok: true } & T) | { ok: false; error: string }) => void;

/** Sent with canvas:join. The owner token (from POST /api/canvas) lets the owner into a private canvas. */
interface JoinOptions {
  ownerToken?: string;
}
type JoinAck = Ack<{
  strokes: StrokeMessage[];
  elements: ElementMessage[];
  isShared: boolean;
  isOwner: boolean;
}>;

// Events the client sends (the server listens for these)
interface ClientToServerEvents {
  // options are optional: canvas:join(id, ack) and canvas:join(id, { ownerToken }, ack) both work
  'canvas:join': (canvasId: string, optionsOrAck: JoinOptions | JoinAck, ack?: JoinAck) => void;
  'canvas:leave': () => void;
  'stroke:add': (stroke: NewStroke, ack: Ack<{ id: string }>) => void;
  /** Removes the sender's most recent stroke. */
  'stroke:undo': (ack: Ack<{ id: string }>) => void;
  /** Removes one stroke by id. */
  'stroke:delete': (strokeId: string, ack: Ack<{}>) => void;
  'element:add': (element: NewElement, ack: Ack<{ id: string }>) => void;
  /** Partial change; last write wins. */
  'element:update': (elementId: string, changes: ElementUpdate, ack: Ack<{}>) => void;
  'element:delete': (elementId: string, ack: Ack<{}>) => void;
  /** Removes every stroke of the canvas. Owner only. */
  'canvas:clear': (ack: Ack<{ removed: number }>) => void;
}

// Events the server pushes to clients
interface ServerToClientEvents {
  'stroke:added': (stroke: StrokeMessage) => void;
  /** A participant undid a stroke. */
  'stroke:removed': (strokeId: string) => void;
  /** A participant deleted a stroke. */
  'stroke:deleted': (strokeId: string) => void;
  'element:added': (element: ElementMessage) => void;
  /** The element's new state (all fields). */
  'element:updated': (element: ElementMessage) => void;
  'element:deleted': (elementId: string) => void;
  /** The owner cleared the canvas. */
  'canvas:cleared': () => void;
  'canvas:peers': (count: number) => void;
  /** The owner made this canvas private; you were removed from it. */
  'canvas:unshared': () => void;
  /** The canvas was deleted; you were removed from it. */
  'canvas:deleted': () => void;
}

interface SocketData {
  /** The canvas this socket is currently in, if any. */
  canvasId?: string;
  /** True if this socket proved ownership of that canvas when it joined. */
  isOwner?: boolean;
  /** The logged-in user, read from the login cookie sent when the socket connected. */
  userId?: string;
}

type CanvasServer = Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;
type CanvasSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

export function registerCanvasSocket(io: CanvasServer): void {
  // Tell everyone in the canvas how many sockets are in it.
  const announcePeers = (canvasId: string) =>
    io.to(canvasId).emit('canvas:peers', io.sockets.adapter.rooms.get(canvasId)?.size ?? 0);

  // Leave the canvas this socket is in (if any) and update the others' headcount.
  function leaveCurrent(socket: CanvasSocket): void {
    const { canvasId } = socket.data;
    if (!canvasId) return;
    socket.leave(canvasId);
    // socket.data is socket.io's place for per-connection state, so it is assigned in place.
    socket.data.canvasId = undefined;
    socket.data.isOwner = undefined;
    announcePeers(canvasId);
  }

  // Remove sockets from a canvas room (all of them, or all but the owner) and tell them why.
  async function evict(canvasId: string, notice: 'canvas:unshared' | 'canvas:deleted', keepOwner: boolean) {
    for (const s of await io.in(canvasId).fetchSockets()) {
      if (keepOwner && s.data.isOwner) continue;
      s.emit(notice);
      s.leave(canvasId);
      // socket.data is socket.io's place for per-connection state, so it is assigned in place.
      s.data.canvasId = undefined;
      s.data.isOwner = undefined;
    }
    announcePeers(canvasId);
  }

  // Domain events from the services (triggered by REST or sockets) become messages to clients.
  // A canvas was made private: everyone except the owner is removed (the owner keeps drawing solo).
  canvasEvents.on('unshared', (canvasId) => void evict(canvasId, 'canvas:unshared', true));
  // A canvas was deleted: everyone is removed.
  canvasEvents.on('deleted', (canvasId) => void evict(canvasId, 'canvas:deleted', false));
  // The canvas room without the socket that caused the change (it already knows).
  const others = (canvasId: string, senderSocketId?: string) => {
    const room = io.to(canvasId);
    return senderSocketId ? room.except(senderSocketId) : room;
  };
  // A stroke was saved (over REST or a socket): push it to the canvas, except to its sender.
  canvasEvents.on('strokeAdded', (stroke, senderSocketId) =>
    others(stroke.canvasId, senderSocketId).emit('stroke:added', stroke));
  // A stroke was undone, or the canvas was cleared.
  canvasEvents.on('strokeRemoved', (canvasId, strokeId, senderSocketId) =>
    others(canvasId, senderSocketId).emit('stroke:removed', strokeId));
  canvasEvents.on('strokeDeleted', (canvasId, strokeId, senderSocketId) =>
    others(canvasId, senderSocketId).emit('stroke:deleted', strokeId));
  canvasEvents.on('elementAdded', (element, senderSocketId) =>
    others(element.canvasId, senderSocketId).emit('element:added', element));
  canvasEvents.on('elementUpdated', (element, senderSocketId) =>
    others(element.canvasId, senderSocketId).emit('element:updated', element));
  canvasEvents.on('elementDeleted', (canvasId, elementId, senderSocketId) =>
    others(canvasId, senderSocketId).emit('element:deleted', elementId));
  canvasEvents.on('cleared', (canvasId, senderSocketId) =>
    others(canvasId, senderSocketId).emit('canvas:cleared'));

  // Undo works on your own strokes. The owner counts as one author across reconnects.
  const senderOf = (socket: CanvasSocket): Sender => ({
    socketId: socket.id,
    authorId: socket.data.isOwner ? 'owner' : socket.id,
  });

  io.on('connection', (socket) => {
    // who is logged in is fixed for the life of the connection: after a login or logout the client reconnects
    // socket.data is socket.io's place for per-connection state, so it is assigned in place.
    socket.data.userId = userIdFromCookieHeader(socket.handshake.headers.cookie) ?? undefined;

    // Join: validate (shared, or private + owner token) -> enter the room -> reply with the saved strokes.
    socket.on('canvas:join', async (canvasId, optionsOrAck, maybeAck) => {
      const ack = typeof optionsOrAck === 'function' ? optionsOrAck : maybeAck;
      if (typeof ack !== 'function') return; // ignore requests without an ack callback
      const options = typeof optionsOrAck === 'object' && optionsOrAck !== null ? optionsOrAck : {};
      const joinable = await getAccessibleCanvas(canvasId, options.ownerToken, socket.data.userId);
      if (!joinable.ok) return ack({ ok: false, error: joinable.error });

      leaveCurrent(socket); // a socket sketches in one canvas at a time
      await socket.join(canvasId);
      // socket.data is socket.io's place for per-connection state, so it is assigned in place.
      socket.data.canvasId = canvasId;
      socket.data.isOwner = joinable.isOwner;

      // saved strokes, oldest first, so the joiner can redraw the canvas as it is now
      ack({
        ok: true,
        isShared: joinable.canvas.isShared,
        isOwner: joinable.isOwner,
        strokes: await listStrokeMessages(canvasId),
        elements: await listElementMessages(canvasId),
      });
      announcePeers(canvasId);
    });

    // Leave the current canvas without disconnecting.
    socket.on('canvas:leave', () => leaveCurrent(socket));

    // Draw: validate -> must be in that canvas -> save (the others are notified) -> ack the sender.
    socket.on('stroke:add', async (raw, ack) => {
      if (typeof ack !== 'function') return;
      const stroke = parseStroke(raw);
      if (!stroke) return ack({ ok: false, error: 'Invalid stroke' });
      // Only strokes for the canvas this socket actually joined are accepted.
      if (stroke.canvasId !== socket.data.canvasId)
        return ack({ ok: false, error: 'Join the canvas before drawing' });

      // Saved, then pushed to the others by the 'strokeAdded' listener above (not back to us).
      const saved = await saveStroke(stroke, senderOf(socket));
      ack(saved);
    });

    // Delete one stroke by id: must be in a canvas; the others are told.
    socket.on('stroke:delete', async (strokeId, ack) => {
      if (typeof ack !== 'function') return;
      const { canvasId } = socket.data;
      if (!canvasId) return ack({ ok: false, error: 'Join the canvas first' });
      const deleted = await deleteStrokeById(canvasId, strokeId, socket.id);
      ack(deleted.ok ? { ok: true } : { ok: false, error: deleted.error });
    });

    // Elements: validate -> must be in that canvas -> save (the others are notified) -> ack the sender.
    socket.on('element:add', async (raw, ack) => {
      if (typeof ack !== 'function') return;
      const element = parseElement(raw);
      if (!element) return ack({ ok: false, error: 'Invalid element' });
      if (element.canvasId !== socket.data.canvasId)
        return ack({ ok: false, error: 'Join the canvas before adding elements' });

      const saved = await addElement(element, socket.id);
      ack(saved.ok ? saved : { ok: false, error: saved.error });
    });

    socket.on('element:update', async (elementId, raw, ack) => {
      if (typeof ack !== 'function') return;
      const { canvasId } = socket.data;
      if (!canvasId) return ack({ ok: false, error: 'Join the canvas before changing elements' });
      const changes = parseElementUpdate(raw);
      if (!changes) return ack({ ok: false, error: 'Invalid element changes' });

      const updated = await updateElement(canvasId, elementId, changes, socket.id);
      ack(updated.ok ? { ok: true } : { ok: false, error: updated.error });
    });

    socket.on('element:delete', async (elementId, ack) => {
      if (typeof ack !== 'function') return;
      const { canvasId } = socket.data;
      if (!canvasId) return ack({ ok: false, error: 'Join the canvas before changing elements' });
      const deleted = await deleteElement(canvasId, elementId, socket.id);
      ack(deleted.ok ? { ok: true } : { ok: false, error: deleted.error });
    });

    // Undo: remove your most recent stroke in this canvas; the others are told.
    socket.on('stroke:undo', async (ack) => {
      if (typeof ack !== 'function') return;
      const { canvasId } = socket.data;
      if (!canvasId) return ack({ ok: false, error: 'Join the canvas before drawing' });
      ack(await undoLastStroke(canvasId, senderOf(socket)));
    });

    // Clear: the owner removes every stroke of the canvas; the others are told.
    socket.on('canvas:clear', async (ack) => {
      if (typeof ack !== 'function') return;
      const { canvasId } = socket.data;
      if (!canvasId) return ack({ ok: false, error: 'Join the canvas first' });
      const cleared = await clearCanvasStrokes(canvasId, { verifiedOwner: socket.data.isOwner === true }, socket.id);
      ack(cleared.ok ? { ok: true, removed: cleared.removed } : { ok: false, error: cleared.error });
    });

    // Rooms are left automatically on disconnect; only the peer count needs refreshing.
    socket.on('disconnecting', () => {
      const { canvasId } = socket.data;
      if (canvasId) setImmediate(() => announcePeers(canvasId));
    });
  });
}
