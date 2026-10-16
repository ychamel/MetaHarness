import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Daemon } from './daemon.ts';
import type { MhEvent } from './types.ts';

/**
 * The Client API (design §13): GET /state, GET /events (server-sent events with replay),
 * POST /commands. The CLI and, later, the UI are both clients of this.
 */
export function startServer(d: Daemon, port: number, token: string): Promise<Server> {
  const server = createServer((req, res) => void handle(d, token, req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function handle(d: Daemon, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const ok = req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;
  if (!ok) return json(res, 401, { error: 'Missing or wrong token. The CLI reads it from the token file in MH_HOME.' });
  try {
    if (req.method === 'GET' && url.pathname === '/state') {
      return json(res, 200, d.snapshot(url.searchParams.get('goal') ?? undefined));
    }
    if (req.method === 'GET' && url.pathname === '/events') return events(d, url, req, res);
    if (req.method === 'POST' && url.pathname === '/commands') {
      const body = await readBody(req);
      return json(res, 200, await d.command(body ? JSON.parse(body) : {}));
    }
    json(res, 404, { error: `There's nothing at ${req.method} ${url.pathname}.` });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
}

/** Replays events after `since`, then streams new ones. Reconnecting clients pass the last seq they saw. */
function events(d: Daemon, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const goal = url.searchParams.get('goal') ?? undefined;
  const since = Number(url.searchParams.get('since') ?? req.headers['last-event-id'] ?? 0) || 0;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const write = (e: MhEvent) => {
    if (!goal || e.goal === goal) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  // Replay and subscribe in the same tick, so no event falls between them.
  for (const e of d.store.since(goal, since)) write(e);
  const off = d.store.subscribe(write);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    off();
    clearInterval(ping);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', c => (s += c));
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}
