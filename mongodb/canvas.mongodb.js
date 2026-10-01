/* global use, db */
// MongoDB Playground for the canvas collection.
// Document shape: { _id, name, isShared, createdAt, updatedAt }
// Play runs every statement in this file. Read-only queries are active;
// statements that change data are commented out, uncomment one at a time.

const database = "sketch-space";
const collection = 'canvas';

use(database);

// --- read ---------------------------------------------------------------

// all canvases, newest first
db.getCollection(collection).find({}).sort({ createdAt: -1 });

// only shared canvases
db.getCollection(collection).find({ isShared: true });

// only private (unshared) canvases
db.getCollection(collection).find({ isShared: false });

// find by name
db.getCollection(collection).find({ name: "yuki" });

// recently updated (last 24 hours)
db.getCollection(collection).find({
  updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
});

// find by id
// db.getCollection(collection).findOne({ _id: ObjectId("<id>") });

// counts: total, shared, private
db.getCollection(collection).aggregate([
  { $group: { _id: "$isShared", count: { $sum: 1 } } },
]);

// --- write (same fields the API sets) -----------------------------------

// insert a canvas
// db.getCollection(collection).insertOne({
//   name: "sample",
//   isShared: false,
//   createdAt: new Date(),
//   updatedAt: new Date(),
// });

// share / unshare a canvas
// db.getCollection(collection).updateOne(
//   { _id: ObjectId("<id>") },
//   { $set: { isShared: true, updatedAt: new Date() } }
// );

// delete a canvas
// db.getCollection(collection).deleteOne({ _id: ObjectId("<id>") });
