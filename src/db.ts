import { MongoClient, type Db } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is not set');

const client = new MongoClient(uri);
let db: Db | undefined;

export async function connectDB(): Promise<void> {
  await client.connect();
  db = client.db();
  console.log('MongoDB connected');
}

export async function closeDB(): Promise<void> {
  await client.close();
  db = undefined;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not connected; call connectDB() first');
  return db;
}
