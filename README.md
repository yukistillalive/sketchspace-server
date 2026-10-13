# Sketchspace Server

Backend for Sketchspace, a collaborative sketching app. A canvas is a sketching room that is either private to its owner or shared with others. Strokes are saved and streamed to everyone on the canvas in real time.

## Features

- Create, list, rename, share and delete canvases over REST
- Live drawing over socket.io with server-side stroke validation
- Stroke history for late joiners
- Solo mode on private canvases and collaboration mode on shared ones

## Tech stack

Node.js, TypeScript, Express, socket.io, MongoDB

## API

| | |
|---|---|
| Base URL | `http://localhost:3000` |
| Format | JSON |
| Authentication | Owner token, no accounts |
| CORS | Origins listed in `CLIENT_ORIGIN` |

REST manages canvases and their strokes. socket.io carries live drawing for solo and shared canvases.

### Quick start

```js
import { io } from 'socket.io-client';
const API = 'http://localhost:3000';

// Create a canvas. The ownerToken is returned once, so store it.
const { canvasId, ownerToken } = await fetch(`${API}/api/canvas`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'my sketch', isShared: true }),
}).then((r) => r.json());

// Join and receive the saved strokes
const socket = io(API);
socket.emit('canvas:join', canvasId, { ownerToken }, (res) => {
  if (!res.ok) return console.error(res.error);
  res.strokes.forEach(draw);
});

// Send a stroke
socket.emit('stroke:add', {
  canvasId, layerId: 'foreground', brush: 'pen', size: 4, color: '#222222', opacity: 1,
  path: [{ x: 10, y: 12 }, { x: 14, y: 18 }],
}, (res) => {});

// Receive strokes from other participants
socket.on('stroke:added', draw);
```

### Authentication

`POST /api/canvas` returns an `ownerToken` once. Only its hash is stored, so it cannot be recovered. Send it as the `X-Owner-Token` header on REST requests and as `{ ownerToken }` in `canvas:join`.

### REST endpoints

| Method | Endpoint | Body | Response | Access |
|---|---|---|---|---|
| GET | `/health` | | `200 { ok: true }` | Anyone |
| POST | `/api/canvas` | `{ name?, isShared? }` | `201 { canvasId, ownerToken }` | Anyone |
| GET | `/api/canvas` | | `200` shared canvases | Anyone |
| GET | `/api/canvas/:id` | | `200` canvas | Shared: anyone. Private: owner |
| PUT | `/api/canvas/:id` | `{ name?, isShared? }` | `200 { ok: true }` | Owner |
| DELETE | `/api/canvas/:id` | | `200 { ok: true }` | Owner |
| POST | `/api/canvas/:id/strokes` | stroke without `canvasId` | `201 { strokeId }` | Shared: anyone. Private: owner |
| GET | `/api/canvas/:id/strokes` | | `200` strokes, oldest first | Shared: anyone. Private: owner |

Errors return `{ error }` with status `400` for an invalid id or body, `403` for a private canvas or a non-owner, and `404` for an unknown canvas.

### Socket events

Client to server:

| Event | Payload | Acknowledgement |
|---|---|---|
| `canvas:join` | `canvasId`, `{ ownerToken? }` | `{ ok, strokes, isShared, isOwner }` or `{ ok: false, error }` |
| `canvas:leave` | | |
| `stroke:add` | stroke | `{ ok, id }` or `{ ok: false, error }` |

Server to client:

| Event | Payload | Meaning |
|---|---|---|
| `stroke:added` | stroke | Another participant added a stroke |
| `canvas:peers` | number | Participants in the canvas |
| `canvas:unshared` | | The canvas became private and you were removed |
| `canvas:deleted` | | The canvas was deleted and you were removed |

A socket must join a canvas before adding strokes and is in one canvas at a time. Senders do not receive their own strokes. After a reconnect, join again to load missed strokes.

### Models

Canvas:

| Field | Type | Description |
|---|---|---|
| `_id` | string | Canvas id |
| `name` | string | Defaults to `untitled` |
| `isShared` | boolean | Defaults to `false` |
| `layers` | `{ id, order, visible }[]` | `foreground`, `middleground`, `background` |
| `createdAt`, `updatedAt` | date | |

Stroke:

| Field | Type | Rules |
|---|---|---|
| `id` | string | Assigned by the server |
| `canvasId` | string | Canvas the socket joined |
| `layerId`, `brush`, `color` | string | Non-empty |
| `size` | number | Greater than 0, at most 500 |
| `opacity` | number | 0 to 1 |
| `path` | `{ x, y }[]` | 1 to 5000 points |

### Modes

| Mode | Condition |
|---|---|
| Solo | Not shared, owner only |
| Collaboration | Shared, more than one participant |

- Private canvases can be joined only with the owner token and are not listed.
- `PUT { isShared: false }` removes every participant except the owner.
- Deleting a canvas removes its strokes and all participants.
- Canvases created before owner tokens have no owner. Anyone can modify them, and they cannot be joined while private.

## Getting started

### Prerequisites

- Node.js 20.6 or later
- Docker

### Installation

```bash
npm install
```

### Configuration

Create `.env`:

```
MONGODB_URI=mongodb://localhost:27017/sketch-space
PORT=3000
CLIENT_ORIGIN=http://localhost:5173
```

`CLIENT_ORIGIN` accepts a comma-separated list of origins.

### Run

```bash
docker run -d -p 27017:27017 --name mongo mongo   # first time
docker start mongo                                # later
npm run dev
```

Open `http://localhost:3000` for the demo client.

### Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start with reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type check source and tests |
| `npm test` | Run all tests |
| `npm run test:socket` | Run socket tests |
| `npm run test:service` | Run service tests |

## Project structure

```
src/
├── index.ts          Entry point
├── db.ts             MongoDB connection
├── routes/           REST handlers
├── socket/           socket.io handlers
├── services/         Rules shared by REST and sockets
├── validation/       Input validation
└── repositories/     MongoDB queries
test/                 Socket and service tests
postman/              REST test collection and environment
mongodb/              MongoDB playground
public/               Demo client
```

REST routes and socket handlers call the services, services call the repositories, and repositories use the connection from `db.ts`.

```
routes/ ──┐
          ├──▶ services/ ──▶ repositories/ ──▶ MongoDB
socket/ ──┘
```

## Testing

### Automated tests

```bash
npm test
```

Tests need MongoDB. They use the `sketch-space-test` database and drop it afterwards. Set `TEST_MONGODB_URI` to use another database whose name ends in `-test`.

### Postman

Install the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-overview/):

```bash
curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh
```

Start the server, then run the collection:

```bash
postman collection run "postman/collections/sketchspace api" \
  -e postman/environments/local.environment.yaml
```

Change `baseUrl` in `postman/environments/local.environment.yaml` if the server uses another port. The CLI exits with a non-zero code when an assertion fails.

## Inspecting the database

Install the MongoDB for VS Code extension, connect to `mongodb://localhost:27017`, and open `sketch-space` → `canvas`. Run queries from `mongodb/canvas.mongodb.js`.
