/**
 * httpApi.ts — the scoreboard's HTTP routes (protocol `scoreboard.ts`): a thin
 * Node layer over the transport-free {@link SoloScoreboard}, served on the
 * relay's port beside the WebSocket upgrade (see `wsServer.ts`).
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { SOLO_API_PREFIX, SOLO_SUBMIT_MAX_BYTES } from '@crack-attack/protocol';
import { clientKey } from './rateLimit.js';
import { ApiError, type SoloScoreboard } from './scoreboard.js';

export interface ScoreboardApiOptions {
  /**
   * Take the client's address from the last `X-Forwarded-For` hop — the one
   * the reverse proxy added. Only set this behind a proxy that sets the
   * header, or clients could pick their own rate-limit key.
   */
  trustProxy?: boolean | undefined;
  /** `Access-Control-Allow-Origin` for the API (the client's origin, or `*`); unset = same-origin only. */
  corsOrigin?: string | undefined;
}

/** A request listener serving the scoreboard routes; anything else is a 404. */
export function createScoreboardApi(
  scoreboard: SoloScoreboard,
  options: ScoreboardApiOptions = {},
): RequestListener {
  return (req, res) => {
    void handle(scoreboard, options, req, res);
  };
}

async function handle(
  scoreboard: SoloScoreboard,
  options: ScoreboardApiOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (options.corsOrigin) res.setHeader('Access-Control-Allow-Origin', options.corsOrigin);
  try {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (!url.pathname.startsWith(`${SOLO_API_PREFIX}/`)) {
      throw new ApiError(404, 'not_found', 'not found');
    }
    const route = url.pathname.slice(SOLO_API_PREFIX.length);
    if (req.method === 'OPTIONS') {
      // CORS preflight (a JSON POST from another origin needs one).
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    const client = clientKey(clientAddress(req, options.trustProxy ?? false));

    if (route === '/ticket') {
      allow(req, 'POST');
      req.resume(); // no body expected; drain whatever came
      send(res, 200, await scoreboard.issueTicket(client));
    } else if (route === '/submit') {
      allow(req, 'POST');
      send(res, 200, await scoreboard.submit(client, await readJson(req)));
    } else if (route === '/scores') {
      allow(req, 'GET');
      send(res, 200, await scoreboard.scores(url.searchParams), 'no-cache');
    } else {
      const replay = /^\/replay\/([^/]+)$/.exec(route);
      if (!replay) throw new ApiError(404, 'not_found', 'not found');
      allow(req, 'GET');
      send(res, 200, await scoreboard.replay(replay[1]!), 'public, max-age=3600');
    }
  } catch (err) {
    if (err instanceof ApiError) {
      send(res, err.status, err.body());
    } else {
      console.error('scoreboard: request failed:', err);
      send(res, 500, { error: 'internal', message: 'internal error' });
    }
  }
}

function allow(req: IncomingMessage, method: 'GET' | 'POST'): void {
  if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) {
    throw new ApiError(405, 'method_not_allowed', `use ${method}`);
  }
}

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header[header.length - 1] : header;
    const last = value?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Read a JSON body of at most SOLO_SUBMIT_MAX_BYTES. */
function readJson(req: IncomingMessage): Promise<unknown> {
  const tooLarge = () =>
    new ApiError(413, 'too_large', `the body is over ${SOLO_SUBMIT_MAX_BYTES} bytes`);
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > SOLO_SUBMIT_MAX_BYTES) {
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > SOLO_SUBMIT_MAX_BYTES) {
        failed = true;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'bad_request', 'the body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, cache = 'no-store'): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': cache,
  };
  if (status === 405) headers['Allow'] = 'GET, POST, OPTIONS';
  if (status === 429 || status === 503) headers['Retry-After'] = '10';
  // An oversized body is left unread; close rather than drain it.
  if (status === 413) headers['Connection'] = 'close';
  res.writeHead(status, headers);
  res.end(text);
}
