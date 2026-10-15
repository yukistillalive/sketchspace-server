import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server as HttpServer } from 'node:http';
import cors from 'cors';
import express from 'express';

process.env.CLIENT_ORIGIN = 'http://localhost:5173, https://app.example.com'; // read by cors.ts on import
const { corsOptions } = await import('../src/cors.js');

let httpServer: HttpServer;
let base: string;

before(async () => {
  const app = express();
  app.use(cors(corsOptions));
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  base = `http://localhost:${(httpServer.address() as { port: number }).port}`;
});

after(() => {
  httpServer.close();
});

describe('CORS', () => {
  // Without these two headers a browser drops the login cookie on cross-origin requests.
  it('lets an allowed origin send and receive cookies', async () => {
    const res = await fetch(`${base}/ping`, { headers: { Origin: 'https://app.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });

  it('answers the preflight for an allowed origin with credentials allowed', async () => {
    const res = await fetch(`${base}/ping`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });

  // The origin is echoed only when listed, never a wildcard (browsers reject '*' with credentials).
  it('does not allow an origin that is not listed', async () => {
    const res = await fetch(`${base}/ping`, { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});
