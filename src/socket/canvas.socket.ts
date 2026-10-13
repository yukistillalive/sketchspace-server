// Real-time layer. A canvas is a sketching room: sockets join it by canvas id, finished
// strokes are saved (stroke.repository) and relayed to everyone else in the room.
import type { Server, Socket } from 'socket.io';
import { canvasEvents } from '../services/canvas.events.js';
import { getAccessibleCanvas } from '../services/canvas.service.js';
import { listStrokeMessages, saveStroke, type StrokeMessage } from '../services/stroke.service.js';
import type { NewStroke } from '../repositories/stroke.repository.js';
import { parseStroke } from '../validation/stroke.validation.js';

// Every client request gets an acknowledgement: { ok: true, ...data } or { ok: false, error }.
type Ack<T> = (result: ({ ok: true } & T) | { ok: false; error: string }) => void;

/** Sent with canvas:join. The owner token (from POST /api/canvas) lets the owner into a private canvas. */
interface JoinOptions {
  ownerToken?: string;
}
type JoinAck = Ack<{ strokes: StrokeMessage[]; isShared: boolean; isOwner: boolean }>;

// Events the client sends (the server listens for these)
interface ClientToServerEvents {
  // options are optional: canvas:join(id, ack) and canvas:join(id, { ownerToken }, ack) both work
  'canvas:join': (canvasId: string, optionsOrAck: JoinOptions | JoinAck, ack?: JoinAck) => void;
  'canvas:leave': () => void;
  'stroke:add': (stroke: NewStroke, ack: Ack<{ id: string }>) => void;
}

// Events the server pushes to clients
interface ServerToClientEvents {
  'stroke:added': (stroke: StrokeMessage) => void;
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
  // A stroke was saved (over REST or a socket): push it to the canvas, except to its sender.
  canvasEvents.on('strokeAdded', (stroke, senderSocketId) => {
    const room = io.to(stroke.canvasId);
    (senderSocketId ? room.except(senderSocketId) : room).emit('stroke:added', stroke);
  });

  io.on('connection', (socket) => {
    // Join: validate (shared, or private + owner token) -> enter the room -> reply with the saved strokes.
    socket.on('canvas:join', async (canvasId, optionsOrAck, maybeAck) => {
      const ack = typeof optionsOrAck === 'function' ? optionsOrAck : maybeAck;
      if (typeof ack !== 'function') return; // ignore requests without an ack callback
      const options = typeof optionsOrAck === 'object' && optionsOrAck !== null ? optionsOrAck : {};
      const joinable = await getAccessibleCanvas(canvasId, options.ownerToken);
      if (!joinable.ok) return ack({ ok: false, error: joinable.error });

      leaveCurrent(socket); // a socket sketches in one canvas at a time
      await socket.join(canvasId);
      socket.data.canvasId = canvasId;
      socket.data.isOwner = joinable.isOwner;

      // saved strokes, oldest first, so the joiner can redraw the canvas as it is now
      ack({
        ok: true,
        isShared: joinable.canvas.isShared,
        isOwner: joinable.isOwner,
        strokes: await listStrokeMessages(canvasId),
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
      const saved = await saveStroke(stroke, socket.id);
      ack(saved);
    });

    // Rooms are left automatically on disconnect; only the peer count needs refreshing.
    socket.on('disconnecting', () => {
      const { canvasId } = socket.data;
      if (canvasId) setImmediate(() => announcePeers(canvasId));
    });
  });
}
