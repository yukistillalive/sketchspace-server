import { createServer } from 'node:http';
import cors from 'cors';
import express,{ type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { corsOptions } from './cors.js';
import { connectDB } from './db.js';
import { canvasRouter } from './routes/canvas.routes.js';
import { elementRouter } from './routes/element.routes.js';
import { strokeRouter } from './routes/stroke.routes.js';
import { registerCanvasSocket } from './socket/canvas.socket.js';
import { authRouter } from './routes/auth.routes.js';
import { userRouter } from './routes/user.routes.js';
import { folderRouter } from './routes/folder.routes.js';
import { ensureUserIndexes } from './repositories/user.repository.js';
import { ensureFolderIndexes } from './repositories/folder.repository.js';
import { UPLOAD_ROOT } from './services/avatar.service.js';

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(new URL('../public', import.meta.url).pathname)); // demo client
// uploaded avatars. Every upload gets a new file name, so browsers may cache them for good.
app.use(
  '/uploads',
  express.static(UPLOAD_ROOT, {
    index: false,
    maxAge: '30d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // the frontend is on another origin
    },
  }),
);
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
app.use('/api/folders', folderRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Too large (pictures: 2 MB at most)' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

await connectDB(); // repositories need the db before any request or socket event
await ensureUserIndexes(); // unique email / googleId
await ensureFolderIndexes(); // folder names unique per account, ignoring case

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: corsOptions });
registerCanvasSocket(io);

httpServer.listen(process.env.PORT, () =>
  console.log(`Server on http://localhost:${process.env.PORT}`)
);
