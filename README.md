# Express + MongoDB Communication Demo for DH2643 seminar

A minimal Express server that stores and retrieves data from MongoDB. When a request
reaches Express, Express queries MongoDB, and the data comes back as JSON.

## Structure

```
.
├── package.json     # config
├── tsconfig.json    # TypeScript config
├── .env             # MongoDB connection string
├── mongodb/
│   └── canvas.mongodb.js     # MongoDB playground for the canvas collection
├── public/
│   └── index.html            # demo sketching client (plain HTML + socket.io client)
└── src/
    ├── db.ts                 # opens the connection, hands out a shared db handle
    ├── canvas.repository.ts  # all MongoDB queries for canvas
    ├── stroke.repository.ts  # all MongoDB queries for strokes
    ├── canvas.routes.ts      # HTTP routes and handlers (REST)
    ├── canvas.socket.ts      # socket.io events for live sketching (real time)
    └── index.ts              # wires the app together and listens
```

A **canvas** is a sketching room: the unit people collaborate in. It can be shared
(others may join) or private. Two entry points lead into the same data layer:

```
REST request ──▶ canvas.routes.ts ──┐
                                    ├──▶ *.repository.ts ──▶ db.ts ──▶ MongoDB
socket event ──▶ canvas.socket.ts ──┘
```

REST (`src/canvas.routes.ts`) creates, lists, shares and deletes canvases. Sockets
(`src/canvas.socket.ts`) carry the live drawing. Neither talks to MongoDB directly;
both call the repositories, which use the one connection opened in `src/db.ts`.
Express and socket.io share a single HTTP server and port (`src/index.ts`).

## Prerequisites

- Node.js (v18+)
- Docker Desktop (running)

## Setup

```bash
npm install express mongodb
```

Create a `.env` file:

```
MONGODB_URI=mongodb://localhost:27017/sketch-space
PORT=3000
# optional: frontend origin(s), comma-separated
CLIENT_ORIGIN=http://localhost:5173
```

## Run

Start MongoDB in a container:

```bash
docker run -d -p 27017:27017 --name mongo mongo
```

On later sessions, reuse the existing container instead:

```bash
docker start mongo
```

Then start the server:

```bash
npm run dev
```

Other scripts: `npm run typecheck`, `npm run build` (emits `dist/`), `npm start` (runs the build).

## API

A canvas is the unit of collaboration: `{ name, isShared, createdAt, updatedAt }`.
`isShared` (default `false`) controls whether other users can join it.

| Method | Path              | Purpose                                                    |
|--------|-------------------|------------------------------------------------------------|
| GET    | `/health`         | Health check, returns `{ "ok": true }`                     |
| POST   | `/api/canvas`     | Create a canvas (`name?`, `isShared?`), returns `canvasId` |
| GET    | `/api/canvas`     | List all canvases                                          |
| GET    | `/api/canvas/:id` | Get one canvas by id                                       |
| PUT    | `/api/canvas/:id` | Partial update: `name` and/or `isShared`                   |
| DELETE | `/api/canvas/:id` | Delete a canvas                                            |

## Real-time sketching (socket.io)

Each canvas is a socket.io room. MongoDB is the source of truth; sockets only deliver.

```
client A ──canvas:join──▶ server ──▶ checks canvas exists and is shared
                                 └─▶ joins room, replies with saved strokes
client A ──stroke:add───▶ server ──▶ validates, saves to `strokes`
                                 ├─▶ acks A with the stroke id
                                 └─▶ stroke:added ──▶ everyone else in the canvas
```

| Event (client → server) | Payload                | Reply / effect                                    |
|-------------------------|------------------------|---------------------------------------------------|
| `canvas:join`           | `canvasId`             | ack `{ ok, strokes }`; only shared canvases can be joined |
| `canvas:leave`          | none                   | leaves the canvas                                 |
| `stroke:add`            | a stroke (see below)   | ack `{ ok, id }`; broadcast to the others         |

| Event (server → client) | Payload            | Meaning                                  |
|-------------------------|--------------------|------------------------------------------|
| `stroke:added`          | stroke + `id`      | another participant finished a stroke    |
| `canvas:peers`          | number             | how many sockets are in the canvas now   |

A stroke is `{ canvasId, layerId, brush, size, color, opacity, path: [{x, y}, ...] }`.
Clients are not trusted: the server validates the shape and size of every stroke and
only accepts strokes for the canvas that socket has joined.

Try it: run the server, open <http://localhost:3000> in two browser windows, click
**New shared canvas** in the first, then paste its id into the second and click
**Join**. Drawing in one window appears in the other when the stroke is finished;
reloading shows the saved strokes.

## Using the API from a frontend

The server speaks two protocols on one port (default `http://localhost:3000`):
**REST** for managing canvases and **socket.io** for live sketching. A canvas is a
sketching room. Typical flow: create or pick a canvas over REST, then join it over
the socket and draw.

> **CORS:** the server only accepts browser requests (REST and socket.io) from the
> origins listed in `CLIENT_ORIGIN` (comma-separated; default `http://localhost:5173`,
> Vite's dev server). Set it to your frontend's URL, e.g.
> `CLIENT_ORIGIN=http://localhost:3001,https://app.example.com`. Requests from other
> origins are blocked by the browser.

### REST


```js
const API = 'http://localhost:3000';

// create → 201 { canvasId }
const { canvasId } = await fetch(`${API}/api/canvas`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'my sketch', isShared: true }),   // both optional
}).then((r) => r.json());

// list → [{ _id, name, isShared, createdAt, updatedAt }, ...]
const canvases = await fetch(`${API}/api/canvas`).then((r) => r.json());

// share / unshare or rename (send name and/or isShared) → { ok: true }
await fetch(`${API}/api/canvas/${canvasId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ isShared: false }),
});
```

`GET /api/canvas/:id` returns one canvas and `DELETE /api/canvas/:id` removes it
(see the table above). Canvas ids are the `_id` string; only **shared** canvases can
be joined over the socket.

### Real time

```js
import { io } from 'socket.io-client';
const socket = io(API);

// 1. join: the ack carries the strokes already saved, oldest first
socket.emit('canvas:join', canvasId, (res) => {
  if (!res.ok) return console.error(res.error);   // e.g. "Canvas is not shared"
  res.strokes.forEach(draw);
});

// 2. draw locally, then send the finished stroke
const stroke = {
  canvasId, layerId: 'foreground', brush: 'pen', size: 4, color: '#222222',
  opacity: 1,                                  // 0..1
  path: [{ x: 10, y: 12 }, { x: 14, y: 18 }],  // 1..5000 points
};
socket.emit('stroke:add', stroke, (res) => { /* { ok: true, id } or { ok: false, error } */ });

// 3. receive other people's strokes (you never get your own back)
socket.on('stroke:added', draw);               // stroke + id
socket.on('canvas:peers', (n) => {});          // participants currently in the canvas
```

- Join before drawing: `stroke:add` is rejected for a canvas the socket hasn't joined.
- A socket is in one canvas at a time; joining another leaves the first.
- After a reconnect, call `canvas:join` again to get the strokes you missed.
- Strokes are sent whole when the pointer is released, not while drawing.
- Stroke messages use `id`; REST canvas objects use `_id`.

## Test

```bash
# create → returns { "canvasId": "..." }
CANVAS=$(curl -s -X POST http://localhost:3000/api/canvas \
  -H "Content-Type: application/json" -d '{"name":"yuki"}' \
  | sed 's/.*"canvasId":"\([^"]*\)".*/\1/')

curl http://localhost:3000/api/canvas            # read all
curl http://localhost:3000/api/canvas/$CANVAS      # read one
curl -X PUT http://localhost:3000/api/canvas/$CANVAS \
  -H "Content-Type: application/json" -d '{"name":"renamed","isShared":true}'   # update / share
curl http://localhost:3000/api/canvas/$CANVAS      # confirm the rename
curl -X DELETE http://localhost:3000/api/canvas/$CANVAS            # delete
curl http://localhost:3000/api/canvas/$CANVAS      # now 404 — confirms delete
```

## Inspect the database

Use the **MongoDB for VS Code** extension (`mongodb.mongodb-vscode`):

1. Open the MongoDB view in the sidebar and click **Add Connection**.
2. Choose **Connect with Connection String** and enter
   `mongodb://localhost:27017` (no spaces).
3. Expand the connection → `sketch-space` → `canvas` to browse the documents.
   Click a document to view or edit it.

Playground scripts live in [mongodb/](mongodb/). Open
[mongodb/canvas.mongodb.js](mongodb/canvas.mongodb.js) and press the **Play**
button to run it; results open in a side panel. It targets:

```js
const database = "sketch-space";
const collection = 'canvas';
```

The file contains queries that match the canvas fields
(`name`, `isShared`, `createdAt`, `updatedAt`): list all (newest first), shared only,
private only, by name, recently updated, and a shared/private count. Running a
playground executes every statement in the file, so the statements that change data
(insert, share/unshare, delete) are commented out; uncomment one at a time. To find or
change a single canvas, replace `<id>` with its `_id`.