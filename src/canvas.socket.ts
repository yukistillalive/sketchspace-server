import type { Server, Socket } from 'socket.io';
import { findCanvas, isValidCanvasId } from './canvas.repository.js';
import { addStroke, listStrokes, type NewStroke, type Stroke } from './stroke.repository.js';

/** A stroke as sent over the wire: persisted fields plus its database id. */
export type StrokeMessage = Omit<Stroke, 'createdAt'> & { id: string };

type Ack<T> = (result: ({ ok: true } & T) | { ok: false; error: string }) => void;

// Client -> server
interface ClientToServerEvents {
  'canvas:join': (canvasId: string, ack: Ack<{ strokes: StrokeMessage[] }>) => void;
  'canvas:leave': () => void;
  'stroke:add': (stroke: NewStroke, ack: Ack<{ id: string }>) => void;
}

// Server -> client
interface ServerToClientEvents {
  'stroke:added': (stroke: StrokeMessage) => void;
  'canvas:peers': (count: number) => void;
}

interface SocketData {
  /** The canvas (sketching room) this socket is currently in, if any. */
  canvasId?: string;
}

type CanvasServer = Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;
type CanvasSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

const MAX_POINTS_PER_STROKE = 5000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Clients are untrusted: check the shape and size of everything we persist and relay. */
function parseStroke(raw: unknown): NewStroke | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;

  if (!isStr(s.canvasId) || !isStr(s.layerId) || !isStr(s.brush) || !isStr(s.color)) return null;
  if (!isNum(s.size) || s.size <= 0 || s.size > 500) return null;
  if (!isNum(s.opacity) || s.opacity < 0 || s.opacity > 1) return null;
  if (!Array.isArray(s.path) || s.path.length === 0 || s.path.length > MAX_POINTS_PER_STROKE)
    return null;
  if (!s.path.every((p) => typeof p === 'object' && p !== null && isNum(p.x) && isNum(p.y)))
    return null;

  return {
    canvasId: s.canvasId,
    layerId: s.layerId,
    brush: s.brush,
    color: s.color,
    size: s.size,
    opacity: s.opacity,
    path: s.path.map((p: { x: number; y: number }) => ({ x: p.x, y: p.y })),
  };
}

export function registerCanvasSocket(io: CanvasServer): void {
  const announcePeers = (canvasId: string) =>
    io.to(canvasId).emit('canvas:peers', io.sockets.adapter.rooms.get(canvasId)?.size ?? 0);

  function leaveCurrent(socket: CanvasSocket): void {
    const { canvasId } = socket.data;
    if (!canvasId) return;
    socket.leave(canvasId);
    socket.data.canvasId = undefined;
    announcePeers(canvasId);
  }

  io.on('connection', (socket) => {
    socket.on('canvas:join', async (canvasId, ack) => {
      if (typeof ack !== 'function') return;
      if (typeof canvasId !== 'string' || !isValidCanvasId(canvasId))
        return ack({ ok: false, error: 'Invalid canvas id' });

      const canvas = await findCanvas(canvasId);
      if (!canvas) return ack({ ok: false, error: 'Canvas not found' });
      if (!canvas.isShared) return ack({ ok: false, error: 'Canvas is not shared' });

      leaveCurrent(socket); // a socket sketches in one canvas at a time
      await socket.join(canvasId);
      socket.data.canvasId = canvasId;

      const strokes = await listStrokes(canvasId);
      ack({
        ok: true,
        strokes: strokes.map(({ _id, createdAt: _c, ...rest }) => ({ ...rest, id: _id.toString() })),
      });
      announcePeers(canvasId);
    });

    socket.on('canvas:leave', () => leaveCurrent(socket));

    socket.on('stroke:add', async (raw, ack) => {
      if (typeof ack !== 'function') return;
      const stroke = parseStroke(raw);
      if (!stroke) return ack({ ok: false, error: 'Invalid stroke' });
      // Only strokes for the canvas this socket actually joined are accepted.
      if (stroke.canvasId !== socket.data.canvasId)
        return ack({ ok: false, error: 'Join the canvas before drawing' });

      const id = await addStroke(stroke);
      ack({ ok: true, id });
      socket.to(stroke.canvasId).emit('stroke:added', { ...stroke, id });
    });

    // Rooms are left automatically on disconnect; only the peer count needs refreshing.
    socket.on('disconnecting', () => {
      const { canvasId } = socket.data;
      if (canvasId) setImmediate(() => announcePeers(canvasId));
    });
  });
}
