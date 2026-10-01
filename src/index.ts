import express from 'express';
import { connectDB } from './db.js';
import { canvasRouter } from './canvas.routes.js';

const app = express();
app.use(express.json());
app.get('/', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/canvas', canvasRouter);

await connectDB();
app.listen(process.env.PORT, () =>
  console.log(`Server on http://localhost:${process.env.PORT}`)
);
