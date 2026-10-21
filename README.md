# Sketchspace Server

REST and real-time backend for [Sketchspace](https://github.com/chaimi760970774/Sketchspace), a collaborative collage and drawing app.

**Frontend repo:** [Sketchspace](https://github.com/chaimi760970774/Sketchspace) · **Live site:** [chaimi760970774.github.io/Sketchspace](https://chaimi760970774.github.io/Sketchspace/) · **API:** `https://91-98-226-226.sslip.io`

A canvas is a room that is either private (solo) or shared (collaboration). The server validates strokes and elements (shapes, photos, cutouts), stores them in MongoDB and streams them to everyone on the canvas in real time. It also handles accounts (email/password and Google), profile pictures and folders.

**Stack:** Node.js 22, TypeScript, Express 5, socket.io, MongoDB, JWT, Docker, Caddy

## System architecture

![System architecture](docs/system-architecture.png)

## Server architecture

| Layer | Folder | Responsibility |
|---|---|---|
| Persistence / Data Access | `src/repositories/`, `src/db.ts` | Database operations: connection, indexes, one repository per collection. |
| Model / Domain | `src/models/` | Data structures and domain entities (`Canvas`, `Stroke`, `CanvasElement`, `Folder`, `User`) with their public views. |
| Service / Business Logic | `src/services/`, `src/validation/` | Application logic and business rules, shared by REST and socket.io. |
| Controller / Routes | `src/routes/`, `src/socket/`, `src/middleware/` | HTTP requests, responses and routing; socket.io events; authentication middleware and cookies. |

```
src/
├── index.ts          Entry point: wires Express, socket.io and the database
├── cors.ts           CORS settings
├── db.ts             MongoDB connection
├── routes/           REST endpoints: auth, user, canvas, stroke, element, folder
├── socket/           socket.io events for live drawing
├── middleware/       Login check, owner token, session cookie
├── services/         Business logic: canvas, stroke, element, folder, user, auth, avatar
├── validation/       Input validation and parsing
├── models/           Domain entities and their public views
└── repositories/     MongoDB queries, one file per collection
test/                 Socket, service, HTTP and unit tests
postman/              REST collection and environment
mongodb/              MongoDB playground
public/               Demo client
```

## Getting started

Requires Node.js 22 and a running MongoDB.

```bash
npm install
cp .env.example .env
npm run dev
```

For Google sign-in, add every address the frontend is opened from under **Authorized JavaScript origins** of the OAuth client in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

## Condensed API Document

### REST endpoints

Access: **anyone**, **shared** (anyone on a shared canvas, only the owner on a private one), **owner**, **login**.

| Endpoint | Result | Params / body |
|---|---|---|
| `GET /health` | `{ ok }` | |
| `POST /api/auth/register` | `201 { user, token }` | `email`, `password`, `displayName` |
| `POST /api/auth/login` | `{ user, token }` | `email`, `password` |
| `POST /api/auth/google` | `{ user, token }` | `idToken` |
| `GET /api/auth/session` | `{ user }`, `null` for a guest | |
| `POST /api/auth/logout` | `{ ok }` | |
| `GET /api/users/me` | the user (**login**) | |
| `PUT /api/users/me` | the updated user (**login**) | `displayName?`, `avatarUrl?` |
| `PUT /api/users/me/avatar` | the updated user (**login**) | image bytes: png, jpeg or webp, max 2 MB |
| `DELETE /api/users/me/avatar` | the updated user (**login**) | |
| `DELETE /api/users/me` | `{ ok }`; also deletes its canvases and folders (**login**) | |
| `POST /api/canvas` | `201 { canvasId, ownerToken }` | `name?`, `isShared?`, `isPublic?` |
| `GET /api/canvas` | public canvases (the Gallery) | |
| `GET /api/canvas/mine` | the user's canvases, each with `folderId` (**login**) | |
| `GET /api/canvas/:id` | the canvas with `isOwner` (**shared**) | |
| `POST /api/canvas/:id/claim` | `{ ok }` (**login** + owner token) | |
| `PUT /api/canvas/:id` | `{ ok }` (**owner**) | `name?`, `isShared?`, `isPublic?` |
| `PUT /api/canvas/:id/folder` | `{ ok }` (**login**, owns canvas and folder) | `folderId` (`null` = no folder) |
| `DELETE /api/canvas/:id` | `{ ok }` (**owner**) | |
| `GET /api/canvas/:id/strokes` | strokes, oldest first (**shared**) | |
| `POST /api/canvas/:id/strokes` | `201 { strokeId }` (**shared**) | a stroke |
| `DELETE /api/canvas/:id/strokes/:strokeId` | `{ ok }` (**shared**) | |
| `DELETE /api/canvas/:id/strokes` | `{ ok, removed }` (**owner**) | |
| `GET /api/canvas/:id/elements` | elements, oldest first (**shared**) | |
| `POST /api/canvas/:id/elements` | `201 { elementId }` (**shared**) | an element |
| `PUT /api/canvas/:id/elements/:elementId` | `{ ok }` (**shared**) | the changed fields |
| `DELETE /api/canvas/:id/elements/:elementId` | `{ ok }` (**shared**) | |
| `GET /api/folders` | the user's folders (**login**) | |
| `POST /api/folders` | `201` the folder (**login**) | `name` |
| `PUT /api/folders/:id` | the folder (**login**, folder owner) | `name` |
| `DELETE /api/folders/:id` | `{ ok }`; its canvases are kept (**login**, folder owner) | |

Uploaded profile pictures are served from `/uploads/avatars/<file>`.

### socket.io

A socket joins one canvas at a time and must join before sending anything else. Every client event has an acknowledgement receiving `{ ok: true, ...data }` or `{ ok: false, error }`. The login is read from the cookie sent with the connection; reconnect after logging in or out.

| Client to server | Payload | Ack data |
|---|---|---|
| `canvas:join` | `canvasId`, `{ ownerToken? }` | `strokes`, `elements`, `isShared`, `isPublic`, `isOwner` |
| `canvas:leave` | | |
| `stroke:add` / `stroke:delete` / `stroke:undo` | stroke / stroke id / none | `id` (add, undo) |
| `canvas:clear` (owner) | | `removed` |
| `element:add` / `element:update` / `element:delete` | element / id + changes / id | `id` (add) |

| Server to client | Payload | Meaning |
|---|---|---|
| `stroke:added`, `stroke:removed`, `stroke:deleted` | stroke or stroke id | A stroke was added, undone or deleted |
| `canvas:cleared` | | The owner cleared all strokes |
| `element:added`, `element:updated`, `element:deleted` | element or id | An element changed (`updated` carries its full new state) |
| `canvas:peers` | number | Participants in the canvas |
| `canvas:unshared`, `canvas:deleted` | | The canvas became private or was deleted; you were removed |

### Data models

| Entity | Fields |
|---|---|
| **Canvas** | `_id`, `name` (default `untitled`), `isShared` (default `false`; anyone with the id can join), `isPublic` (default `false`; also listed in the Gallery, implies `isShared`), `layers` (`foreground`, `middleground`, `background`), `createdAt`, `updatedAt`, `folderId` (only in `/canvas/mine`) |
| **Folder** | `id`, `name` (trimmed, 1-30 characters, unique per account ignoring case), `createdAt`, `updatedAt` |
| **Stroke** | `id`, `canvasId`, `layerId`, `brush`, `color`, `size` (0-500), `opacity` (0-1), `path` (1-5000 `{ x, y }` points) |
| **Element** | `id`, `canvasId`, `type` (`shape`, `photo`, `cutout`; fixed), `x`, `y`, `width`, `height`, `rotation`, `zIndex`, plus per type: `shape`, `color` (`null` = dashed template); `url`, `photographer`, `photographerLink` (https Unsplash image); `cutWidth`, `cutHeight`, `photo` (cutout) |
| **User** | `id`, `email`, `displayName` (2-30 characters), `avatarUrl`, `hasCustomAvatar`, `createdAt` |

## Testing

```bash
npm test
```

Tests need MongoDB. They use the `sketch-space-test` database and drop it afterwards; set `TEST_MONGODB_URI` to use another database whose name ends in `-test`. The default is `mongodb://localhost:27017`; if MongoDB runs only through Docker Compose it is on port `27018`:

```bash
TEST_MONGODB_URI=mongodb://localhost:27018/sketch-space-test npm test
```

To run the REST collection with the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-overview/) against a running server:

```bash
postman collection run "postman/collections/sketchspace api" -e postman/environments/local.environment.yaml
```

## Deployment

The server runs on a VPS with Docker Compose: MongoDB, the backend and Caddy, which gets and renews the HTTPS certificate itself.

1. Clone the repo on the server and copy `.env.example` to `.env`. Set a real `JWT_SECRET`, `CLIENT_ORIGIN` (the deployed frontend's origin, e.g. `https://chaimi760970774.github.io`), `GOOGLE_CLIENT_ID` and `SITE_ADDRESS` (the server's public hostname).
2. `docker compose up -d --build`
3. Check `docker compose ps` and `https://<SITE_ADDRESS>/health`.

To update a running server: `ssh root@<server-ip>`, `cd ~/sketchspace-server`, `git pull`, `docker compose up -d --build`.

## Inspecting the database

MongoDB is published only on the VPS's own loopback (`127.0.0.1:27018`). To look at the hosted data from VS Code, forward that port over SSH, then connect to it with the [MongoDB for VS Code](https://marketplace.visualstudio.com/items?itemName=mongodb.mongodb-vscode) extension. In VS Code, add a connection to `mongodb://localhost:27018`.

```bash
# connect to VPS and keep this terminal open
ssh -N -L 27018:127.0.0.1:27018 root@<server-ip>
```