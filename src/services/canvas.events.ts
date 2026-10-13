// Lets services announce changes without knowing about socket.io. The socket layer
// subscribes (see socket/canvas.socket.ts) and turns them into messages for connected clients.
import { EventEmitter } from 'node:events';
import type { StrokeMessage } from './stroke.service.js';

interface CanvasEvents {
  /** A canvas was made private: everyone except the owner must leave. */
  unshared: [canvasId: string];
  /** A canvas was deleted: everyone must leave. */
  deleted: [canvasId: string];
  /** A stroke was saved: push it to the canvas, except to the socket that sent it (if any). */
  strokeAdded: [stroke: StrokeMessage, senderSocketId?: string];
}

class CanvasEventEmitter extends EventEmitter {
  override emit<K extends keyof CanvasEvents>(event: K, ...args: CanvasEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof CanvasEvents>(event: K, listener: (...args: CanvasEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof CanvasEvents>(event: K, listener: (...args: CanvasEvents[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export const canvasEvents = new CanvasEventEmitter();
