# Sketchspace Server

Backend for Sketchspace, a collaborative collage doodling app. A canvas is a room that is either private (solo) or shared (collaboration). Strokes and elements (shapes, photos, cutouts) are validated, saved in MongoDB and streamed to everyone on the canvas in real time.

**Stack:** Node.js, TypeScript, Express, socket.io, MongoDB

## API

| | |
|---|---|
| Base URL | `http://localhost:3000` |
| Format | JSON |
| Authentication | Owner token, no accounts |
| CORS | Origins listed in `CLIENT_ORIGIN`, credentials allowed |

### REST or socket

REST and socket.io write through the same services, so a change made either way reaches everyone connected to the canvas.

| Situation | Use |
|---|---|
| Create, list, rename, share, delete a canvas | REST |
| Open a canvas and load its strokes and elements | Socket `canvas:join` |
| Draw and edit while the canvas is open | Socket |
| Read without joining (preview, export) | REST `GET` |
| Write without a live connection (scripts, imports, retries, offline sync) | REST `POST`, `PUT`, `DELETE` |

- Use one path per feature; do not send the same change over both.
- After a reconnect, call `canvas:join` again to load what you missed.
- Socket changes are not echoed to their sender. REST changes go to everyone connected.

### Quick start

```js
import { io } from 'socket.io-client';
const API = 'http://localhost:3000';

// 1. Create a canvas (REST). The ownerToken is returned once: store it.
const { canvasId, ownerToken } = await fetch(`${API}/api/canvas`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'my sketch', isShared: true }),
}).then((r) => r.json());

// 2. Join and load saved content (socket)
const socket = io(API);
socket.emit('canvas:join', canvasId, { ownerToken }, (res) => {
  if (!res.ok) return console.error(res.error);
  res.strokes.forEach(drawStroke);
  res.elements.forEach(drawElement);
});

// 3. Send changes. Every call has an acknowledgement.
socket.emit('stroke:add', {
  canvasId, layerId: 'foreground', brush: 'pen', size: 4, color: '#222222', opacity: 1,
  path: [{ x: 10, y: 12 }, { x: 14, y: 18 }],
}, (res) => {});
socket.emit('element:add', {
  canvasId, type: 'shape', shape: 'circle', color: null,
  x: 40, y: 60, width: 100, height: 100, rotation: 0, zIndex: 1,
}, (res) => {}); // res.id is the element id

// 4. Receive other participants' changes
socket.on('stroke:added', drawStroke);
socket.on('element:added', drawElement);
socket.on('element:updated', drawElement);
socket.on('element:deleted', removeElement);
```

### Authentication

`POST /api/canvas` returns an `ownerToken` once; only its hash is stored. Send it as the `X-Owner-Token` header on REST requests and as `{ ownerToken }` in `canvas:join`.

The login cookie (`token`, set by `/api/auth/*`) is `httpOnly`. A browser frontend on another origin must send requests with credentials (`fetch(..., { credentials: 'include' })`, `io(url, { withCredentials: true })`), and its exact origin must be listed in `CLIENT_ORIGIN`. Wildcard origins are not supported.

A canvas created while logged in also belongs to that account, so its owner can open and manage it from any device without the owner token. A guest's canvas belongs to the owner token only. `POST /api/canvas/:id/claim` (logged in, with the canvas's `X-Owner-Token`) attaches a token-owned canvas to the account. `canvas:join` takes the login from the cookie sent with the socket connection; reconnect the socket after logging in or out.

Access levels: **Anyone**; **Shared** (anyone on a shared canvas, only the owner on a private one); **Owner** (only the owner); **Logged in** (a valid login cookie or `Authorization: Bearer <token>`).

### REST endpoints

Errors return `{ error }` with status `400` (invalid id or body), `401` (not logged in, on Logged in routes), `403` (private canvas or not the owner), `404` (unknown canvas, stroke, element or folder) or `409` (folder name already taken).

| Method | Endpoint | Body | Response | Access |
|---|---|---|---|---|
| GET | `/health` | | `200 { ok }` | Anyone |
| POST | `/api/canvas` | `{ name?, isShared? }` | `201 { canvasId, ownerToken }` | Anyone |
| GET | `/api/canvas` | | `200` shared canvases | Anyone |
| GET | `/api/canvas/mine` | | `200` the logged-in user's canvases, shared and private, each with `folderId` | Logged in |
| GET | `/api/canvas/:id` | | `200` canvas with `isOwner` | Shared |
| POST | `/api/canvas/:id/claim` | | `200 { ok }` | Logged in + owner token |
| PUT | `/api/canvas/:id` | `{ name?, isShared? }` | `200 { ok }` | Owner |
| PUT | `/api/canvas/:id/folder` | `{ folderId }` (folder id, or `null` for no folder) | `200 { ok }` | Logged in, owner of canvas and folder |
| DELETE | `/api/canvas/:id` | | `200 { ok }` | Owner |
| GET | `/api/canvas/:id/strokes` | | `200` strokes, oldest first | Shared |
| POST | `/api/canvas/:id/strokes` | stroke without `canvasId` | `201 { strokeId }` | Shared |
| DELETE | `/api/canvas/:id/strokes/:strokeId` | | `200 { ok }` | Shared |
| DELETE | `/api/canvas/:id/strokes` | | `200 { ok, removed }` | Owner |
| GET | `/api/canvas/:id/elements` | | `200` elements, oldest first | Shared |
| POST | `/api/canvas/:id/elements` | element without `canvasId` | `201 { elementId }` | Shared |
| PUT | `/api/canvas/:id/elements/:elementId` | changed fields | `200 { ok }` | Shared |
| DELETE | `/api/canvas/:id/elements/:elementId` | | `200 { ok }` | Shared |
| GET | `/api/folders` | | `200` the logged-in user's folders, oldest first | Logged in |
| POST | `/api/folders` | `{ name }` | `201` folder | Logged in |
| PUT | `/api/folders/:id` | `{ name }` | `200` renamed folder | Logged in, folder owner |
| DELETE | `/api/folders/:id` | | `200 { ok }` | Logged in, folder owner |

### Folders

An account can sort the canvases it owns into folders. Folders are private: only their owner can list, rename or delete them, and `folderId` is only returned by `GET /api/canvas/mine` (never by the public canvas endpoints). A canvas is in at most one folder.

- Names are trimmed, then must be 1 to 30 characters. One account cannot have two folders whose names differ only in case (`Work` and ` work ` clash); different accounts can.
- `PUT /api/canvas/:id/folder` works only on canvases that belong to the logged-in account (a canvas owned by an owner token alone must be claimed first) and only with that account's folders. Moving a canvas does not change its `updatedAt`.
- Deleting a folder keeps its canvases; their `folderId` becomes `null`. Deleting an account also deletes its folders.

| Endpoint | 400 | 401 | 403 | 404 | 409 |
|---|---|---|---|---|---|
| `GET /api/folders` | | not logged in | | | |
| `POST /api/folders` | invalid name | not logged in | | | name taken |
| `PUT /api/folders/:id` | invalid id or name | not logged in | another account's folder | unknown folder | name taken |
| `DELETE /api/folders/:id` | invalid id | not logged in | another account's folder | unknown folder | |
| `PUT /api/canvas/:id/folder` | invalid canvas id, missing or invalid `folderId` | not logged in | another account's canvas or folder | unknown canvas or folder | |

### Socket events

A socket must join a canvas before sending anything else, and is in one canvas at a time. Every client event takes an acknowledgement that receives `{ ok: true, ...data }` or `{ ok: false, error }`.

Client to server:

| Event | Payload | Ack data | Access |
|---|---|---|---|
| `canvas:join` | `canvasId`, `{ ownerToken? }` | `strokes`, `elements`, `isShared`, `isOwner` | Shared |
| `canvas:leave` | | | |
| `stroke:add` | stroke | `id` | Joined |
| `stroke:delete` | stroke id | | Joined |
| `stroke:undo` | | `id` | Joined |
| `canvas:clear` | | `removed` | Owner |
| `element:add` | element | `id` | Joined |
| `element:update` | element id, changed fields | | Joined |
| `element:delete` | element id | | Joined |

Server to client (never sent to the socket that made the change, except `canvas:peers`):

| Event | Payload | Meaning |
|---|---|---|
| `stroke:added` | stroke | A stroke was added |
| `stroke:removed` | stroke id | A stroke was undone |
| `stroke:deleted` | stroke id | A stroke was deleted |
| `canvas:cleared` | | The owner cleared all strokes |
| `element:added` | element | An element was added |
| `element:updated` | element | An element changed; carries its full new state |
| `element:deleted` | element id | An element was deleted |
| `canvas:peers` | number | Participants in the canvas |
| `canvas:unshared` | | The canvas became private; you were removed |
| `canvas:deleted` | | The canvas was deleted; you were removed |

- `stroke:undo` removes the caller's latest stroke. The owner is one author across connections; a guest is one author per connection. Strokes added over REST cannot be undone.
- Clearing removes strokes only; elements are untouched.
- Concurrent element updates are last write wins in server arrival order. The server sets `updatedAt`.

### Models

**Canvas**

| Field | Type | Description |
|---|---|---|
| `_id` | string | |
| `name` | string | Default `untitled` |
| `isShared` | boolean | Default `false` |
| `layers` | `{ id, order, visible }[]` | `foreground`, `middleground`, `background` |
| `createdAt`, `updatedAt` | date | |
| `folderId` | string or null | Only in `GET /api/canvas/mine`. `null` = in no folder |

**Folder**

| Field | Type | Rules |
|---|---|---|
| `id` | string | Assigned by the server |
| `name` | string | Trimmed, 1 to 30 characters, unique per account ignoring case |
| `createdAt`, `updatedAt` | date | Set by the server |

**Stroke**

| Field | Type | Rules |
|---|---|---|
| `id` | string | Assigned by the server |
| `canvasId` | string | The joined canvas |
| `layerId`, `brush`, `color` | string | Non-empty |
| `size` | number | Above 0, at most 500 |
| `opacity` | number | 0 to 1 |
| `path` | `{ x, y }[]` | 1 to 5000 points |

**Element**

| Field | Type | Rules |
|---|---|---|
| `id` | string | Assigned by the server |
| `canvasId` | string | The joined canvas |
| `type` | string | `shape`, `photo` or `cutout`; cannot be changed |
| `x`, `y` | number | -100000 to 100000 |
| `width`, `height` | number | Above 0, at most 20000 |
| `rotation` | number | -36000 to 36000 degrees |
| `zIndex` | number | -1000000 to 1000000 |
| `shape` | string | Shape, cutout; required. `rectangle`, `square`, `circle`, `ellipse`, `triangle`, `diamond`, `pentagon`, `hexagon`, `star`, `heart`, `line`, `arrow` |
| `color` | string or null | Shape; optional, up to 64 characters. `null` is a dashed template |
| `url` | string | Photo, cutout; required. `https` Unsplash image URL, up to 2048 characters |
| `photographer` | string | Photo, cutout; optional, up to 200 characters |
| `photographerLink` | string | Photo, cutout; optional `https` URL |
| `cutWidth`, `cutHeight` | number | Cutout; required. Above 0, at most 20000 |
| `photo` | `{ x, y, width, height, rotation }` | Cutout; required. Same ranges as above |
| `createdAt`, `updatedAt` | date | Set by the server |

Updates take any non-empty subset of these fields except `id`, `canvasId` and `type`. On creation, fields that do not belong to the element's type are ignored. Elements store the image URL only; clients load the image from Unsplash.

### Modes

| Mode | Condition |
|---|---|
| Solo | Private canvas, owner only |
| Collaboration | Shared canvas |

- Private canvases are not listed and can be joined only with the owner token.
- `PUT { isShared: false }` removes every participant except the owner.
- Deleting a canvas removes its strokes, elements and participants.
- Canvases created before owner tokens have no owner: anyone can modify them, and they cannot be joined while private.

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start with reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type check source and tests |
| `npm test` | Run all tests |
| `npm run test:socket` | Socket tests only |
| `npm run test:service` | Service tests only |
| `npm run test:ownership` | Account ownership tests only |
| `npm run test:folder` | Folder service tests only |

## Deployment with Docker

Runs the backend together with its MongoDB. Requires Docker (with Compose) and Git; there is nothing else to install. The frontend is deployed separately.

1. Clone this repo on the server.
2. Copy `.env.example` to `.env` and set `CLIENT_ORIGIN` (the address of your frontend) and `JWT_SECRET`. The file explains every setting.
3. Run `docker compose up -d --build`.
4. Check that `http://<server>:3000/health` answers.

To update, pull the repo and run step 3 again. Use `docker compose logs -f backend` for logs and `docker compose down` to stop; the database is kept in a Docker volume.

- MongoDB is published only on the server's own `127.0.0.1:27018` (change with `MONGO_PORT`), so you can inspect it from that machine but not from outside. Do not expose it publicly: it has no password.
- Serve the API over HTTPS in production (hosting platform or a reverse proxy). The login cookie is `Secure; SameSite=None`, so browsers drop it over plain HTTP, except on `localhost` in Chrome.
- The frontend must send requests with credentials and its exact origin must match `CLIENT_ORIGIN`, otherwise the browser blocks the cookie.

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
postman/              REST collection and environment
mongodb/              MongoDB playground
public/               Demo client
```

```
routes/ ──┐
          ├──▶ services/ ──▶ repositories/ ──▶ MongoDB
socket/ ──┘
```

## Testing

```bash
npm test
```

Tests need MongoDB. They use the `sketch-space-test` database and drop it afterwards; set `TEST_MONGODB_URI` to use another database whose name ends in `-test`.

To run the REST collection with the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-overview/), start the server and run:

```bash
postman collection run "postman/collections/sketchspace api" \
  -e postman/environments/local.environment.yaml
```

Change `baseUrl` in the environment file if the server uses another port. The CLI exits non-zero when an assertion fails.

## Inspecting the database

With the MongoDB for VS Code extension, connect to `mongodb://localhost:27017` and open `sketch-space`. Queries are in `mongodb/canvas.mongodb.js`.
