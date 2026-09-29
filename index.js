import express from 'express';
import { ObjectId } from 'mongodb';
import { connectDB, getDb } from './db.js';

const app = express();
app.use(express.json());

const rooms = () => getDb().collection('rooms');

// create
app.post('/api/rooms', async (req, res) => {
  const result = await rooms().insertOne({ name: req.body.name ?? 'untitled' });
  res.status(201).json({ roomId: result.insertedId });
});

// read all
app.get('/api/rooms', async (req, res) => {
  const all = await rooms().find().toArray();
  res.json(all);
});

// read one
app.get('/api/rooms/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id))
    return res.status(400).json({ error: 'Invalid room id' });

  const room = await rooms().findOne({ _id: new ObjectId(req.params.id) });
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

// update
app.put('/api/rooms/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id))
    return res.status(400).json({ error: 'Invalid room id' });

  const result = await rooms().updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { name: req.body.name } }
  );
  if (result.matchedCount === 0)
    return res.status(404).json({ error: 'Room not found' });
  res.json({ ok: true });
});

// delete
app.delete('/api/rooms/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id))
    return res.status(400).json({ error: 'Invalid room id' });

  const result = await rooms().deleteOne({ _id: new ObjectId(req.params.id) });
  if (result.deletedCount === 0)
    return res.status(404).json({ error: 'Room not found' });
  res.json({ ok: true });
});

await connectDB();
app.listen(process.env.PORT, () =>
  console.log(`Server on http://localhost:${process.env.PORT}`)
);