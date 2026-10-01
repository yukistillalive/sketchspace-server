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
└── src/
    ├── db.ts                 # opens the connection, hands out a shared db handle
    ├── canvas.repository.ts  # all MongoDB queries for canvas
    ├── canvas.routes.ts      # HTTP routes and handlers
    └── index.ts              # wires the app together and listens
```

A request enters at `src/index.ts`, is matched to a route in `src/canvas.routes.ts`,
and the handler calls a function in `src/canvas.repository.ts`, which reaches MongoDB
over the connection opened once in `src/db.ts`.

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
| GET    | `/`               | Health check, returns `{ "ok": true }`                     |
| POST   | `/api/canvas`     | Create a canvas (`name?`, `isShared?`), returns `canvasId` |
| GET    | `/api/canvas`     | List all canvases                                          |
| GET    | `/api/canvas/:id` | Get one canvas by id                                       |
| PUT    | `/api/canvas/:id` | Partial update: `name` and/or `isShared`                   |
| DELETE | `/api/canvas/:id` | Delete a canvas                                            |

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