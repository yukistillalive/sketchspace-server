import type { CorsOptions } from 'cors';

// Frontend origin(s) allowed to call the API from a browser, comma-separated.
export const clientOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

// credentials: the browser may send and store the login cookie. That requires an explicit
// origin list (never '*'), which CLIENT_ORIGIN already is. Used by Express and socket.io.
export const corsOptions: CorsOptions = { origin: clientOrigins, credentials: true };
