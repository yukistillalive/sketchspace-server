import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { connectDB } from './db.js';
import { canvasRouter } from './canvas.routes.js';
import { registerCanvasSocket } from './canvas.socket.js';

// Frontend origin(s) allowed to call the API from a browser, comma-separated.
const clientOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

const app = express();
app.use(cors({ origin: clientOrigins }));
app.use(express.json());
app.use(express.static(new URL('../public', import.meta.url).pathname)); // demo client
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/canvas', canvasRouter);

await connectDB(); // repositories need the db before any request or socket event

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: clientOrigins } });
registerCanvasSocket(io);

httpServer.listen(process.env.PORT, () =>
  console.log(`Server on http://localhost:${process.env.PORT}`)
);
