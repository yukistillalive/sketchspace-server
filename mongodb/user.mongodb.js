/* global use, db */
// MongoDB Playground for the users collection.
// Document shape: { _id, email, displayName, passwordHash?, googleId?, avatarUrl?, createdAt, updatedAt }
// passwordHash is absent for accounts that only sign in with Google; googleId is absent for
// accounts that only use a password. email is stored lower-case.
// Play runs every statement in this file. Read-only queries are active;
// statements that change data are commented out, uncomment one at a time.
// Queries hide passwordHash, so a hash never ends up on screen by accident.

const database = "sketch-space";
const collection = 'users';

use(database);

// --- read ---------------------------------------------------------------

// all users, newest first (without the password hash)
db.getCollection(collection).find({}, { passwordHash: 0 }).sort({ createdAt: -1 });

// find by email (emails are stored lower-case)
db.getCollection(collection).find({ email: "me@example.com" }, { passwordHash: 0 });

// find by id
// db.getCollection(collection).findOne({ _id: ObjectId("<id>") }, { projection: { passwordHash: 0 } });

// users who signed in with Google
db.getCollection(collection).find({ googleId: { $exists: true } }, { passwordHash: 0 });

// users with a password (email + password accounts)
db.getCollection(collection).find({ passwordHash: { $exists: true } }, { passwordHash: 0 });

// users who have both (a Google account linked to a password account)
db.getCollection(collection).find(
  { googleId: { $exists: true }, passwordHash: { $exists: true } },
  { passwordHash: 0 }
);

// signed up in the last 24 hours
db.getCollection(collection).find(
  { createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  { passwordHash: 0 }
);

// counts: total, with Google, with a password
db.getCollection(collection).aggregate([
  {
    $group: {
      _id: null,
      total: { $sum: 1 },
      withGoogle: { $sum: { $cond: [{ $ifNull: ["$googleId", false] }, 1, 0] } },
      withPassword: { $sum: { $cond: [{ $ifNull: ["$passwordHash", false] }, 1, 0] } },
    },
  },
]);

// the indexes: expect unique email and a unique (partial) googleId
db.getCollection(collection).getIndexes();

// --- write (same fields the API sets) -----------------------------------

// change a display name or remove an avatar
// db.getCollection(collection).updateOne(
//   { email: "me@example.com" },
//   { $set: { displayName: "New name", updatedAt: new Date() }, $unset: { avatarUrl: "" } }
// );

// delete one user
// db.getCollection(collection).deleteOne({ email: "me@example.com" });

// clean up the accounts created by the Postman collection (postman<timestamp>@example.com)
// db.getCollection(collection).deleteMany({ email: /^postman\d+@example\.com$/ });

// Not here on purpose: inserting users by hand. A real password needs the server's salted
// scrypt hash, so create accounts with POST /api/auth/register instead.