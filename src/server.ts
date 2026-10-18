import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Daemon } from './daemon.ts';
import { handleMcp } from './mcp.ts';
import type { MhEvent } from './types.ts';

/**
 * The Client API (design §13): GET /state, GET /events (server-sent events with replay),
 * POST /commands. The CLI and, later, the UI are both clients of this.
 */
export function startServer(d: Daemon, port: number, token: string): Promise<Server> {
  const server = createServer((req, res) => void handle(d, token, req, res));
  // wait() and quick spawns hold requests open for minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      d.mcpBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve(server);
    });
  });
}

async function handle(d: Daemon, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  // Agents reach their tools at /mcp/<agent token>; the token in the path is their credential.
  const mcp = url.pathname.match(/^\/mcp\/([0-9a-f]+)\/?$/);
  if (mcp) {
    try {
      const raw = req.method === 'POST' ? await readBody(req) : '';
      return await handleMcp(d, mcp[1], req, res, raw ? JSON.parse(raw) : undefined);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: (e as Error).message }, id: null });
      return;
    }
  }
  // Harness hooks reach the daemon at /hook/<agent token>, the same credential as MCP.
  const hook = url.pathname.match(/^\/hook\/([0-9a-f]+)\/?$/);
  if (hook && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      return json(res, 200, await d.hook(hook[1], raw ? JSON.parse(raw) : { event: 'before_model' }));
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }
  // The web app (design §14). Its files hold no data; everything it shows comes from the API below.
  if (req.method === 'GET' && !API_PATHS.has(url.pathname)) return serveUi(url.pathname, res);
  const ok = req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;
  if (!ok) return json(res, 401, { error: 'Missing or wrong token. The CLI reads it from the token file in MH_HOME.' });
  try {
    if (req.method === 'GET' && url.pathname === '/state') {
      return json(res, 200, d.snapshot(url.searchParams.get('goal') ?? undefined));
    }
    if (req.method === 'GET' && url.pathname === '/events') return events(d, url, req, res);
    if (req.method === 'GET' && url.pathname === '/goals') return json(res, 200, { goals: d.listGoals() });
    if (req.method === 'GET' && url.pathname === '/agent') {
      const goal = url.searchParams.get('goal'), name = url.searchParams.get('name');
      if (!goal || !name) return json(res, 400, { error: 'GET /agent needs ?goal=<id>&name=<agent>.' });
      return json(res, 200, d.agentDetail(goal, name));
    }
    if (req.method === 'GET' && url.pathname === '/file') {
      const goal = url.searchParams.get('goal'), path = url.searchParams.get('path'), v = url.searchParams.get('version');
      if (!goal || !path) return json(res, 400, { error: 'GET /file needs ?goal=<id>&path=<path in the shared folder>.' });
      return json(res, 200, d.sharedFile(goal, path, v ? Number(v) : undefined));
    }
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
  // A reconnecting EventSource repeats the same URL and says where it got to in Last-Event-ID.
  const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0) || 0;
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

const API_PATHS = new Set(['/state', '/events', '/goals', '/agent', '/file', '/commands']);

/** The built web app (ui/dist). */
export const UI_DIR = join(import.meta.dirname, '..', 'ui', 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

function serveUi(path: string, res: ServerResponse): void {
  const index = join(UI_DIR, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end('<!doctype html><title>MetaHarness</title><p>The web app isn\'t built yet. Run <code>npm run ui:build</code> in the MetaHarness folder, then reload. The API is up: <code>/state</code>, <code>/events</code>, <code>/goals</code>, <code>/agent</code>, <code>/commands</code>.</p>');
  }
  const file = normalize(join(UI_DIR, decodeURIComponent(path)));
  // Anything outside the app, or a route the app handles itself, gets index.html.
  const inside = file.startsWith(UI_DIR + sep) && existsSync(file) && statSync(file).isFile();
  const served = inside ? file : index;
  res.writeHead(200, { 'content-type': TYPES[extname(served)] ?? 'application/octet-stream', 'cache-control': served === index ? 'no-cache' : 'max-age=31536000, immutable' });
  res.end(readFileSync(served));
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
