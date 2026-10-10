# Sketchspace Server

Backend for Sketchspace, a collaborative sketching app. People sketch together on a shared canvas in real time, and every stroke is saved so a canvas can be reopened where it was left.

## Features

- REST API to create, list, rename, share and delete canvases
- Real-time drawing over socket.io: strokes are validated, saved and sent to everyone on the canvas
- Late joiners receive the strokes already drawn
- Shared canvases (anyone with the id can join) and private ones

Built with Node.js, TypeScript, Express, socket.io and MongoDB.

The API is documented below. To run the server locally, see [Setup](#setup) and
[Run](#run).

## API

- **REST API**: manage canvases
- **socket.io API** for live drawing

| | |
|---|---|
| **Base URL** | `http://localhost:3000` (port set by `PORT`) |
| **Format** | JSON requests and responses |
| **Auth** | none yet |
| **CORS** | browsers may call the API from the origins in `CLIENT_ORIGIN` (comma-separated, default `http://localhost:5173`) |

### Quick start

```js
import { io } from 'socket.io-client';
const API = 'http://localhost:3000';

// 1. create a shared canvas → 201 { canvasId }
const { canvasId } = await fetch(`${API}/api/canvas`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'my sketch', isShared: true }),
}).then((r) => r.json());

// 2. join it; the ack carries the strokes already saved, oldest first
const socket = io(API);
socket.emit('canvas:join', canvasId, (res) => {
  if (!res.ok) return console.error(res.error);   // e.g. "Canvas is not shared"
  res.strokes.forEach(draw);
});

// 3. send a finished stroke; other participants receive it
socket.emit('stroke:add', {
  canvasId, layerId: 'foreground', brush: 'pen', size: 4, color: '#222222', opacity: 1,
  path: [{ x: 10, y: 12 }, { x: 14, y: 18 }],
}, (res) => { /* { ok: true, id } or { ok: false, error } */ });

// 4. draw what others send
socket.on('stroke:added', draw);
```

### Canvas

| Field | Type | Notes |
|---|---|---|
| `_id` | string | canvas id |
| `name` | string | defaults to `"untitled"` |
| `isShared` | boolean | defaults to `false`; only shared canvases can be joined |
| `createdAt`, `updatedAt` | ISO date | `updatedAt` changes on every update |

### REST endpoints

| Method | Endpoint | Body | Success response |
|---|---|---|---|
| GET | `/health` | none | `200 { "ok": true }` |
| POST | `/api/canvas` | `{ name?, isShared? }` | `201 { "canvasId": "..." }` |
| GET | `/api/canvas` | none | `200` array of canvases |
| GET | `/api/canvas/:id` | none | `200` canvas |
| PUT | `/api/canvas/:id` | `{ name?, isShared? }`, at least one | `200 { "ok": true }` |
| DELETE | `/api/canvas/:id` | none | `200 { "ok": true }` |

Errors are `{ "error": "message" }` with status `400` (invalid id or body) or `404`
(canvas not found).

### Real-time events (socket.io)

Connect with `io(API)`.

| Client → server | Payload | Reply |
|---|---|---|
| `canvas:join` | `canvasId` | ack `{ ok: true, strokes }` or `{ ok: false, error }`; the canvas must exist and be shared |
| `canvas:leave` | none | none |
| `stroke:add` | a stroke | ack `{ ok: true, id }` or `{ ok: false, error }`; saved, then sent to the others |

| Server → client | Payload | Meaning |
|---|---|---|
| `stroke:added` | stroke + `id` | another participant finished a stroke |
| `canvas:peers` | number | participants currently in the canvas |

A **stroke** is:

| Field | Type | Rules |
|---|---|---|
| `canvasId` | string | must be the canvas this socket joined |
| `layerId`, `brush`, `color` | string | non-empty |
| `size` | number | greater than 0, up to 500 |
| `opacity` | number | 0 to 1 |
| `path` | `{ x, y }[]` | 1 to 5000 points, finite numbers |

Notes:
- Join before drawing; `stroke:add` is rejected for a canvas the socket has not joined.
- A socket is in one canvas at a time; joining another leaves the first.
- You do not receive your own strokes back. After a reconnect, call `canvas:join` again
  to get what you missed.
- Strokes are sent whole when the pointer is released, not while drawing.
- Stroke messages use `id`; REST canvases use `_id`.

---

## Structure

```
.
├── package.json     # config
├── tsconfig.json    # TypeScript config
├── .env             # MongoDB connection string
├── mongodb/
│   └── canvas.mongodb.js     # MongoDB playground for the canvas collection
├── postman/
│   ├── collections/sketchspace api/  # REST API tests (Postman collection, one file per request)
│   └── environments/local.environment.yaml  # baseUrl for the tests
├── public/
│   └── index.html            # demo sketching client (plain HTML + socket.io client)
├── test/
│   └── socket.test.ts        # automated socket.io tests
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

## Postman API tests

### Setup

1. Install the Postman CLI (macOS / Linux):

   ```bash
   curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh
   ```

   For Windows and other options see the
   [Postman CLI docs](https://learning.postman.com/docs/postman-cli/postman-cli-overview/).

   Sign in, or set up a project without an account: `postman login` or `postman init`.

2. Start MongoDB and the server (see "Run"), so the API is listening on
   `http://localhost:3000`. If your server uses another port, change `baseUrl` in
   [postman/environments/local.environment.yaml](postman/environments/local.environment.yaml).

### Run

```bash
# create → returns { "canvasId": "..." }
CANVAS=$(curl -s -X POST http://localhost:3000/api/canvas \
  -H "Content-Type: application/json" -d '{"name":"yuki"}' \
  | sed 's/.*"canvasId":"\([^"]*\)".*/\1/')

# simple POST to create canvas on Windows:
CANVAS=$(curl -s -X POST http://localhost:3000/api/canvas \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"yuki\"}" \
  | sed 's/.*"canvasId":"\([^"]*\)".*/\1/')

# POST with full test sequence on Windows
curl -s -X POST http://localhost:3000/api/canvas \                                                   
  -H "Content-Type: application/json" \
  -d "{\"name\":\"yuki\"}"


curl http://localhost:3000/api/canvas            # read all
curl http://localhost:3000/api/canvas/$CANVAS      # read one
curl -X PUT http://localhost:3000/api/canvas/$CANVAS \
  -H "Content-Type: application/json" -d '{"name":"renamed","isShared":true}'   # update / share
curl http://localhost:3000/api/canvas/$CANVAS      # confirm the rename
curl -X DELETE http://localhost:3000/api/canvas/$CANVAS            # delete
curl http://localhost:3000/api/canvas/$CANVAS      # now 404 — confirms delete

# Or run the Postman collection:
postman collection run "postman/collections/sketchspace api" \
  -e postman/environments/local.environment.yaml
```

## Automated socket tests

`npm run test:socket` runs `test/socket.test.ts`: it starts the socket layer on a random
port, connects real `socket.io-client` sockets and checks joining (invalid, unknown and
private canvases are rejected), stroke relay (others receive it, the sender and
outsiders do not), saving, validation of bad strokes, late joiners receiving saved
strokes, and the participant count.

## Inspect the database

Use the **MongoDB for VS Code** extension (`mongodb.mongodb-vscode`):

1. Open the MongoDB view in the sidebar and click **Add Connection**.
2. Choose **Connect with Connection String** and enter
   `mongodb://localhost:27017` (no spaces).
3. Expand the connection → `sketch-space` → `canvas` to browse the documents.