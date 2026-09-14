/**
 * httpApi.ts — the scoreboard's HTTP routes (protocol `scoreboard.ts`): a thin
 * Node layer over the transport-free {@link SoloScoreboard}, served on the
 * relay's port beside the WebSocket upgrade (see `wsServer.ts`).
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { SOLO_API_PREFIX, SOLO_SUBMIT_MAX_BYTES } from '@crack-attack/protocol';
import { clientKey } from './rateLimit.js';
import { ApiError, type SoloScoreboard } from './scoreboard.js';
import { renderSharePage, sharePageCsp } from './sharePage.js';

/** A ticket request needs no body; anything past this much is refused unread. */
const TICKET_MAX_BODY_BYTES = 1024;
/** For a refusal that leaves the body unread: close the connection rather than drain it. */
const CLOSE_CONNECTION = { Connection: 'close' } as const;

export interface ScoreboardApiOptions {
  /**
   * How many reverse proxies in front of the relay append to
   * `X-Forwarded-For` (true = 1). The client's address is taken that many
   * entries from the right: behind nginx alone, the one nginx added; behind a
   * CDN and nginx, the one the CDN added. Only set this behind proxies that
   * set the header, or clients could pick their own rate-limit key; and with
   * more than one, the inner proxies must be reachable only through the outer
   * ones (a client reaching nginx directly could forge the CDN's entry).
   */
  trustProxy?: boolean | number | undefined;
  /** `Access-Control-Allow-Origin` for the API (the client's origin, or `*`); unset = same-origin only. */
  corsOrigin?: string | undefined;
  /**
   * The game's address, ending in `/`: where share pages send people, and
   * where their preview image is. Unset = the request's own host, over the
   * scheme a trusted proxy reports in `X-Forwarded-Proto` (else http), which
   * fits a relay behind the game's own nginx.
   */
  publicUrl?: string | undefined;
}

/** The client went away mid-request: there's no one left to answer. */
class ClientGoneError extends Error {
  constructor() {
    super('the client went away');
    this.name = 'ClientGoneError';
  }
}

/** A request listener serving the scoreboard routes; anything else is a 404. */
export function createScoreboardApi(
  scoreboard: SoloScoreboard,
  options: ScoreboardApiOptions = {},
): RequestListener {
  const proxyHops = options.trustProxy === true ? 1 : options.trustProxy || 0;
  return (req, res) => {
    void handle(scoreboard, options, proxyHops, req, res);
  };
}

async function handle(
  scoreboard: SoloScoreboard,
  options: ScoreboardApiOptions,
  proxyHops: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (options.corsOrigin) res.setHeader('Access-Control-Allow-Origin', options.corsOrigin);
  try {
    const url = parseUrl(req.url ?? '/');
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
    const client = clientKey(clientAddress(req, proxyHops));

    if (route === '/ticket') {
      allow(req, 'POST');
      await readBody(req, TICKET_MAX_BODY_BYTES); // none expected; a bounded read keeps it that way
      send(res, 200, await scoreboard.issueTicket(client));
    } else if (route === '/submit') {
      allow(req, 'POST');
      // The submission is spent before its body is read (up to 256 KiB) and
      // parsed, so a client over its limit, or sending a burst at once, is
      // turned away unread; the connection goes with the unread body.
      try {
        scoreboard.admitSubmission(client);
      } catch (err) {
        throw err instanceof ApiError ? err.withHeaders(CLOSE_CONNECTION) : err;
      }
      send(res, 200, await scoreboard.submitAdmitted(await readJson(req)));
    } else if (route === '/scores') {
      allow(req, 'GET');
      send(res, 200, await scoreboard.scores(client, url.searchParams), 'no-cache');
    } else {
      const [, kind, idText] = /^\/(replay|share)\/([^/]+)$/.exec(route) ?? [];
      if (idText === undefined) throw new ApiError(404, 'not_found', 'not found');
      allow(req, 'GET');
      if (kind === 'replay') {
        // Briefly: a run hidden by a moderator should drop out of caches soon.
        sendText(res, 200, await scoreboard.replay(client, idText), 'public, max-age=60');
      } else {
        const card = await scoreboard.shareCard(client, idText);
        const game = options.publicUrl ?? requestGameUrl(req, proxyHops);
        // A few minutes: a run's places move, and a hidden run should drop out.
        sendHtml(res, card ? 200 : 404, renderSharePage(card, game), sharePageCsp(game));
      }
    }
  } catch (err) {
    if (err instanceof ClientGoneError) return; // an aborted upload: nothing to say, no one to say it to
    if (err instanceof ApiError) {
      send(res, err.status, err.body(), 'no-store', err.headers);
    } else {
      console.error('scoreboard: request failed:', err);
      send(res, 500, { error: 'internal', message: 'internal error' });
    }
  }
}

function parseUrl(path: string): URL {
  try {
    return new URL(path, 'http://relay');
  } catch {
    throw new ApiError(400, 'bad_request', 'malformed request URL');
  }
}

/** Refuse any method but the route's own (GET routes take HEAD too), saying which are allowed. */
function allow(req: IncomingMessage, method: 'GET' | 'POST'): void {
  if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) {
    throw new ApiError(405, 'method_not_allowed', `use ${method}`, {
      Allow: method === 'GET' ? 'GET, HEAD, OPTIONS' : 'POST, OPTIONS',
    });
  }
}

/**
 * The game's address, taken to be this request's host: the default for
 * {@link ScoreboardApiOptions.publicUrl}. A malformed `Host` gets localhost.
 */
export function requestGameUrl(req: IncomingMessage, proxyHops: number): string {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = proxyHops > 0 && typeof forwarded === 'string' ? forwarded.split(',')[0] : '';
  const scheme = proto?.trim() === 'https' ? 'https' : 'http';
  const host = req.headers.host ?? '';
  // The shape check keeps out a path or query; URL refuses the rest (a port past 65535).
  if (/^(?:[\w.-]+|\[[\da-fA-F:.]+\])(?::\d{1,5})?$/.test(host)) {
    try {
      return new URL(`${scheme}://${host}/`).href;
    } catch {
      // Malformed after all: localhost, below.
    }
  }
  return `${scheme}://localhost/`;
}

/** The client's address: from `X-Forwarded-For` behind trusted proxies, else the socket's. */
function clientAddress(req: IncomingMessage, proxyHops: number): string {
  const forwarded = forwardedAddress(req.headers['x-forwarded-for'], proxyHops);
  return forwarded ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * The client address in an `X-Forwarded-For` header, `hops` entries from the
 * right: each trusted proxy appends the address it was reached from, so
 * that's the one the outermost trusted proxy saw. A shorter header yields its
 * first entry. Null if `hops` is 0, or the entry isn't an IP address.
 */
export function forwardedAddress(
  header: string | readonly string[] | undefined,
  hops: number,
): string | null {
  if (hops < 1 || header === undefined) return null;
  const entries = (typeof header === 'string' ? header : header.join(',')).split(',');
  const entry = entries[Math.max(0, entries.length - hops)];
  return entry === undefined ? null : parseAddress(entry);
}

/**
 * An address as a proxy wrote it, without any port or brackets
 * (`1.2.3.4:5678`, `[2001:db8::1]:5678`); null if it isn't an IP address.
 */
export function parseAddress(entry: string): string | null {
  let address = entry.trim();
  const bracketed = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(address);
  if (bracketed) address = bracketed[1]!;
  else if (/^[\d.]+:\d{1,5}$/.test(address)) address = address.slice(0, address.lastIndexOf(':'));
  return isIP(address) === 0 ? null : address;
}

/** Read a JSON body of at most SOLO_SUBMIT_MAX_BYTES. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, SOLO_SUBMIT_MAX_BYTES);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'bad_request', 'the body is not valid JSON');
  }
}

/**
 * Read a body of at most `maxBytes`; a larger one is refused (413) without
 * reading the rest. A client that hangs up part-way rejects with
 * {@link ClientGoneError}.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  // The rest is left unread.
  const tooLarge = () =>
    new ApiError(413, 'too_large', `the body is over ${maxBytes} bytes`, CLOSE_CONNECTION);
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > maxBytes) {
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    // An abort shows up as an 'aborted' error, then 'close' without 'end'. Once
    // the promise has settled either way, these are no-ops.
    req.on('error', () => reject(new ClientGoneError()));
    req.on('close', () => {
      if (!req.complete) reject(new ClientGoneError());
    });
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  cache = 'no-store',
  extra: Readonly<Record<string, string>> = {},
): void {
  sendText(res, status, JSON.stringify(body), cache, extra);
}

/** {@link send} for a body that's already JSON text. */
function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  cache = 'no-store',
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': cache,
    ...extra,
  });
  res.end(text);
}

/** A share page: HTML, locked down by its CSP, cached a few minutes. */
function sendHtml(res: ServerResponse, status: number, html: string, csp: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'public, max-age=300',
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}
