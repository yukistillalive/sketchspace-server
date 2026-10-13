import { createServer } from 'node:http';
import cors from 'cors';
import express,{ type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { connectDB } from './db.js';
import { canvasRouter } from './routes/canvas.routes.js';
import { elementRouter } from './routes/element.routes.js';
import { strokeRouter } from './routes/stroke.routes.js';
import { registerCanvasSocket } from './socket/canvas.socket.js';
import { authRouter } from './routes/auth.routes.js';
import { userRouter } from './routes/user.routes.js';
import { ensureUserIndexes } from './repositories/user.repository.js';

// Frontend origin(s) allowed to call the API from a browser, comma-separated.
const clientOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

const app = express();
app.use(cors({ origin: clientOrigins }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(new URL('../public', import.meta.url).pathname)); // demo client
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
app.get('/', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/canvas', canvasRouter);
app.use('/api/canvas', strokeRouter);
app.use('/api/canvas', elementRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', userRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

await connectDB(); // repositories need the db before any request or socket event
await ensureUserIndexes(); // unique email / googleId

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: clientOrigins } });
registerCanvasSocket(io);

httpServer.listen(process.env.PORT, () =>
  console.log(`Server on http://localhost:${process.env.PORT}`)
);
