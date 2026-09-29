import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);
let db;

export async function connectDB() {
  await client.connect();
  db = client.db();
  console.log('MongoDB connected');
}

export function getDb() {
  return db;
}