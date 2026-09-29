# Express + MongoDB Communication Demo for DH2643 seminar

A minimal Express server that stores and retrieves data from MongoDB. When a request
reaches Express, Express queries MongoDB, and the data comes back as JSON.

## Structure

```
.
├── package.json     # config
├── .env             # MongoDB connection string
├── db.js            # opens the connection, hands out a shared db handle
└── index.js         # server, routes, handlers, listen
```

A request enters at `index.js`, is matched to a route, handled inline, and the
handler calls `getDb().collection('rooms')` to reach MongoDB over the connection
opened once in `db.js`.

## Prerequisites

- Node.js (v18+)
- Docker Desktop (running)

## Setup

```bash
npm install express mongodb
```

Create a `.env` file:

```
MONGODB_URI=mongodb://localhost:27017/demo
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

## API

| Method | Path             | Purpose                                    |
|--------|------------------|--------------------------------------------|
| POST   | `/api/rooms`     | Create a room, returns its id (`insertOne`) |
| GET    | `/api/rooms`     | List all rooms (`find().toArray()`)         |
| GET    | `/api/rooms/:id` | Get one room by id (`findOne`)              |
| PUT    | `/api/rooms/:id` | Update a room's name (`updateOne` + `$set`) |
| DELETE | `/api/rooms/:id` | Delete a room (`deleteOne`)                 |

## Test

```bash
# create → returns { "roomId": "..." }
ROOM=$(curl -s -X POST http://localhost:3000/api/rooms \
  -H "Content-Type: application/json" -d '{"name":"yuki"}' \
  | sed 's/.*"roomId":"\([^"]*\)".*/\1/')

curl http://localhost:3000/api/rooms            # read all
curl http://localhost:3000/api/rooms/$ROOM      # read one
curl -X PUT http://localhost:3000/api/rooms/$ROOM \
  -H "Content-Type: application/json" -d '{"name":"renamed"}'   # update
curl http://localhost:3000/api/rooms/$ROOM      # confirm the rename
curl -X DELETE http://localhost:3000/api/rooms/$ROOM            # delete
curl http://localhost:3000/api/rooms/$ROOM      # now 404 — confirms delete
```
Inspect the database:

- **MongoDB Compass** (GUI): connect to `mongodb://localhost:27017`, open the
  `demo` database → `rooms` collection.
- **Shell:**

  ```bash
  docker exec -it mongo mongosh
  use demo
  db.rooms.find()
  ```

## Docker commands

| Command              | Purpose                           |
|----------------------|-----------------------------------|
| `docker ps`          | See running containers            |
| `docker stop mongo`  | Stop MongoDB                      |
| `docker start mongo` | Start it again (not `docker run`) |
| `docker logs mongo`  | View MongoDB output               |
| `docker rm mongo`  | Remove container     |