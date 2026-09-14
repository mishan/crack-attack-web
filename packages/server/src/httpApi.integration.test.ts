/**
 * Integration: the scoreboard's HTTP routes on the relay's real HTTP server,
 * beside its WebSocket, on an ephemeral port.
 */

import { readFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { SoloReplay } from '@crack-attack/core';
import { PROTOCOL_VERSION, SOLO_SUBMIT_MAX_BYTES, encodeMessage } from '@crack-attack/protocol';
import { createScoreboardApi, forwardedAddress, parseAddress, requestGameUrl } from './httpApi.js';
import { SoloScoreboard } from './scoreboard.js';
import { MemoryScoreStore } from './scoreStore.js';
import { SoloVerifier } from './soloVerifier.js';
import { startRelayWsServer, type RelayWsServer } from './wsServer.js';

/** A real solo game (hard AI, seed 2026): 2757 ticks, score 48, top multiplier 3. */
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../core/src/fixtures/solo-hard-2026.replay.json', import.meta.url)),
    'utf8',
  ),
) as SoloReplay;
const ORIGIN = 'https://game.example';

let server: RelayWsServer;
let base: string;
let clock: { now: number };

beforeEach(async () => {
  clock = { now: Date.UTC(2026, 8, 13, 12) };
  const scoreboard = new SoloScoreboard({
    store: new MemoryScoreStore(),
    now: () => clock.now,
    newSeed: () => FIXTURE.seed,
    ticketLimit: { capacity: 2, refillMs: 60_000 },
  });
  server = await startRelayWsServer({
    port: 0,
    host: '127.0.0.1',
    http: createScoreboardApi(scoreboard, { trustProxy: true, corsOrigin: ORIGIN }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

describe('scoreboard HTTP API', () => {
  it('runs the whole flow: ticket, submission, board, replay', async () => {
    const ticketRes = await post('/api/solo/ticket');
    expect(ticketRes.status).toBe(200);
    expect(ticketRes.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ticketRes.headers.get('cache-control')).toBe('no-store');
    const ticket = (await ticketRes.json()) as { runId: string; seed: number };
    expect(ticket.seed).toBe(FIXTURE.seed);

    clock.now += FIXTURE.ticks * 20 + 3000;
    const submitRes = await post('/api/solo/submit', {
      runId: ticket.runId,
      name: 'misha',
      replay: FIXTURE,
    });
    expect(submitRes.status).toBe(200);
    expect(await submitRes.json()).toMatchObject({ id: 1, score: 48, topMultiplier: 3 });

    const scoresRes = await fetch(`${base}/api/solo/scores?period=month`);
    expect(scoresRes.headers.get('cache-control')).toBe('no-cache');
    expect(await scoresRes.json()).toMatchObject({
      month: '2026-09',
      total: 1,
      entries: [{ rank: 1, id: 1, name: 'misha', score: 48 }],
    });

    const replayRes = await fetch(`${base}/api/solo/replay/1`);
    expect(replayRes.status).toBe(200);
    // Short, so a run a moderator hides soon drops out of caches.
    expect(replayRes.headers.get('cache-control')).toBe('public, max-age=60');
    expect(((await replayRes.json()) as { replay: unknown }).replay).toEqual(FIXTURE);
  });

  it("serves a run's share page, and a plain one for a run it doesn't show", async () => {
    const ticket = (await (await post('/api/solo/ticket')).json()) as { runId: string };
    clock.now += FIXTURE.ticks * 20 + 3000;
    await post('/api/solo/submit', { runId: ticket.runId, name: 'misha', replay: FIXTURE });

    // No PUBLIC_URL here: the game is taken to be at this host, over the
    // scheme the (trusted) proxy reports.
    const game = `https://127.0.0.1:${server.port}/`;
    const res = await fetch(`${base}/api/solo/share/1`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('content-security-policy')).toContain(
      `img-src https://127.0.0.1:${server.port};`,
    );
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="misha scored 48 in Crack Attack!">');
    expect(html).toContain(`<a id="play" href="${game}">`);

    const missing = await fetch(`${base}/api/solo/share/99`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('<title>Crack Attack!</title>');
    expect((await fetch(`${base}/api/solo/share/1/x`)).status).toBe(404);
  });

  it("takes the game's address from the request when none is configured", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
    const https = { host: 'example.com', 'x-forwarded-proto': 'https' };
    expect(requestGameUrl(req(https), 1)).toBe('https://example.com/');
    // Only a trusted proxy's word counts.
    expect(requestGameUrl(req(https), 0)).toBe('http://example.com/');
    expect(requestGameUrl(req({ host: '[::1]:8080' }), 0)).toBe('http://[::1]:8080/');
    expect(requestGameUrl(req({ host: 'x.example/"><script>' }), 0)).toBe('http://localhost/');
    expect(requestGameUrl(req({}), 0)).toBe('http://localhost/');
  });

  it('answers CORS preflights', async () => {
    const res = await fetch(`${base}/api/solo/submit`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('answers unknown routes, wrong methods and bad JSON with JSON errors', async () => {
    const notFound = await fetch(`${base}/api/solo/nope`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: 'not_found' });
    expect((await fetch(`${base}/`)).status).toBe(404);

    // Each route names its own methods.
    const getTicket = await fetch(`${base}/api/solo/ticket`);
    expect(getTicket.status).toBe(405);
    expect(getTicket.headers.get('allow')).toBe('POST, OPTIONS');
    const postScores = await post('/api/solo/scores', {});
    expect(postScores.status).toBe(405);
    expect(postScores.headers.get('allow')).toBe('GET, HEAD, OPTIONS');

    const badJson = await post('/api/solo/submit', '{not json');
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ error: 'bad_request' });
  });

  it('refuses an oversized submission without reading it', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: '/api/solo/submit',
          headers: {
            'content-type': 'application/json',
            'content-length': String(SOLO_SUBMIT_MAX_BYTES + 1),
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      // The server hangs up on the rest of the body; that's the point.
      req.on('error', (err) => (req.destroyed ? undefined : reject(err)));
      req.write('{');
    });
    expect(status).toBe(413);
  });

  it('spends a submission before reading its body, so a burst is turned away unread', async () => {
    const scoreboard = new SoloScoreboard({
      store: new MemoryScoreStore(),
      submitLimit: { capacity: 1, refillMs: 60_000 },
    });
    const api = createScoreboardApi(scoreboard);
    let arrived!: () => void;
    const firstArrived = new Promise<void>((resolve) => (arrived = resolve));
    const relay = await startRelayWsServer({
      port: 0,
      host: '127.0.0.1',
      http: (req, res) => {
        api(req, res); // admits (or refuses) before it first waits
        arrived();
      },
    });
    // Each declares a body it never sends, so any answer came before reading it.
    const submit = () =>
      request({
        host: '127.0.0.1',
        port: relay.port,
        method: 'POST',
        path: '/api/solo/submit',
        headers: { 'content-type': 'application/json', 'content-length': '100000' },
      });
    const first = submit();
    first.on('error', () => undefined); // hung up on below
    first.write('{');
    try {
      await firstArrived; // let in, and waiting for its body
      const answer = await new Promise<{ status: number; headers: Record<string, unknown> }>(
        (resolve, reject) => {
          const req = submit();
          req.on('response', (res) => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers });
            res.resume();
            req.destroy();
          });
          req.on('error', (err) => (req.destroyed ? undefined : reject(err)));
          req.write('{');
        },
      );
      expect(answer.status).toBe(429);
      expect(answer.headers['connection']).toBe('close');
      expect(answer.headers['retry-after']).toBe('60');
    } finally {
      first.destroy();
      await relay.close();
    }
  });

  it('rate-limits replay requests, HEAD included', async () => {
    const scoreboard = new SoloScoreboard({
      store: new MemoryScoreStore(),
      replayLimit: { capacity: 2, refillMs: 60_000 },
    });
    const relay = await startRelayWsServer({
      port: 0,
      host: '127.0.0.1',
      http: createScoreboardApi(scoreboard),
    });
    try {
      const url = `http://127.0.0.1:${relay.port}/api/solo/replay/1`;
      expect((await fetch(url)).status).toBe(404);
      expect((await fetch(url, { method: 'HEAD' })).status).toBe(404);
      const limited = await fetch(url);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
    } finally {
      await relay.close();
    }
  });

  it('refuses a ticket request with a body over 1 KiB', async () => {
    expect((await post('/api/solo/ticket', 'x'.repeat(2048))).status).toBe(413);
    expect((await post('/api/solo/ticket', '{}')).status).toBe(200);
  });

  it('rate-limits by the address the proxy reports', async () => {
    const via = (forwardedFor: string) =>
      post('/api/solo/ticket', undefined, { 'x-forwarded-for': forwardedFor });
    expect((await via('198.51.100.1')).status).toBe(200);
    expect((await via('10.0.0.1, 198.51.100.1')).status).toBe(200);
    // Only the proxy's own (last) hop counts; a client-supplied first hop doesn't.
    const limited = await via('10.0.0.9, 198.51.100.1');
    expect(limited.status).toBe(429);
    // When the limiter will have room again: one ticket per 60 s here.
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await via('198.51.100.2')).status).toBe(200);
  });

  it('strips ports from forwarded addresses, and falls back to the socket for garbage', async () => {
    const via = (forwardedFor: string) =>
      post('/api/solo/ticket', undefined, { 'x-forwarded-for': forwardedFor });
    // One client behind a proxy that writes ports, not three.
    expect((await via('198.51.100.1:5000')).status).toBe(200);
    expect((await via('198.51.100.1:5001')).status).toBe(200);
    expect((await via('198.51.100.1:5002')).status).toBe(429);
    // Not an address: keyed by the socket (127.0.0.1 here), not a fresh bucket each.
    expect((await via('nonsense')).status).toBe(200);
    expect((await via('more-nonsense')).status).toBe(200);
    expect((await via('still-nonsense')).status).toBe(429);
  });

  it('picks the client out of X-Forwarded-For behind two proxies', async () => {
    const scoreboard = new SoloScoreboard({
      store: new MemoryScoreStore(),
      ticketLimit: { capacity: 1, refillMs: 60_000 },
    });
    const relay = await startRelayWsServer({
      port: 0,
      host: '127.0.0.1',
      http: createScoreboardApi(scoreboard, { trustProxy: 2 }),
    });
    const via = async (forwardedFor: string) =>
      (
        await fetch(`http://127.0.0.1:${relay.port}/api/solo/ticket`, {
          method: 'POST',
          headers: { 'x-forwarded-for': forwardedFor },
        })
      ).status;
    try {
      // The CDN adds the client, then nginx adds the CDN edge: the client is second from the right.
      expect(await via('198.51.100.7:5000, 10.0.0.1')).toBe(200);
      // The same client via another edge, with a spoofed first entry: the same bucket.
      expect(await via('203.0.113.99, 198.51.100.7, 10.0.0.2')).toBe(429);
      expect(await via('[2001:db8::1]:443, 10.0.0.1')).toBe(200);
      expect(await via('[2001:db8::2]:443, 10.0.0.1')).toBe(429); // the same /64
    } finally {
      await relay.close();
    }
  });

  it('answers a malformed request URL with a 400, without logging it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        // fetch would normalize the path; `//` is not a valid URL path here.
        const req = request({ host: '127.0.0.1', port: server.port, path: '//' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(400);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('drops an upload the client abandons, without logging it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let arrived!: () => void;
    let gone!: () => void;
    const requestArrived = new Promise<void>((resolve) => (arrived = resolve));
    const requestGone = new Promise<void>((resolve) => (gone = resolve));
    const api = createScoreboardApi(new SoloScoreboard({ store: new MemoryScoreStore() }));
    const relay = await startRelayWsServer({
      port: 0,
      host: '127.0.0.1',
      http: (req, res) => {
        req.on('close', gone);
        api(req, res);
        arrived();
      },
    });
    try {
      const req = request({
        host: '127.0.0.1',
        port: relay.port,
        method: 'POST',
        path: '/api/solo/submit',
        headers: { 'content-type': 'application/json', 'content-length': '1000' },
      });
      req.on('error', () => undefined); // hanging up is the point
      req.write('{"runId":');
      await requestArrived;
      req.destroy();
      await requestGone;
      await new Promise((resolve) => setTimeout(resolve, 20)); // let the handler settle
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await relay.close();
    }
  });

  describe('forwarded addresses', () => {
    it.each([
      ['198.51.100.7', '198.51.100.7'],
      [' 198.51.100.7 ', '198.51.100.7'],
      ['198.51.100.7:5678', '198.51.100.7'],
      ['2001:db8::1', '2001:db8::1'],
      ['[2001:db8::1]', '2001:db8::1'],
      ['[2001:db8::1]:443', '2001:db8::1'],
      ['::ffff:198.51.100.7', '::ffff:198.51.100.7'],
      ['unknown', null],
      ['_hidden', null],
      ['', null],
      ['198.51.100.7:', null],
      ['[198.51.100.7', null],
      ['2001:db8::1:443x', null],
    ])('reads %j as %j', (entry, address) => {
      expect(parseAddress(entry)).toBe(address);
    });

    it('counts trusted proxies from the right', () => {
      const header = '203.0.113.1, 198.51.100.7, 10.0.0.1';
      expect(forwardedAddress(header, 1)).toBe('10.0.0.1');
      expect(forwardedAddress(header, 2)).toBe('198.51.100.7');
      expect(forwardedAddress(header, 3)).toBe('203.0.113.1');
      expect(forwardedAddress(header, 5)).toBe('203.0.113.1'); // a shorter chain: its first entry
      expect(forwardedAddress(['203.0.113.1', '198.51.100.7, 10.0.0.1'], 2)).toBe('198.51.100.7');
      expect(forwardedAddress(header, 0)).toBeNull();
      expect(forwardedAddress(undefined, 1)).toBeNull();
      expect(forwardedAddress('203.0.113.1, garbage', 1)).toBeNull();
    });
  });

  it('still serves the relay WebSocket on the same port', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const welcome = await new Promise<{ type: string; name: string }>((resolve, reject) => {
      ws.on('open', () =>
        ws.send(encodeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'misha' })),
      );
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { type: string; name: string };
        if (msg.type === 'welcome') resolve(msg);
      });
      ws.on('error', reject);
    });
    ws.close();
    expect(welcome.name).toBe('misha');
  });
});

describe('relay shutdown', () => {
  it('lets a submission being verified finish before it closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const verifier = new SoloVerifier({ sliceTicks: 100, yieldFn: () => gate });
    const now = { t: Date.UTC(2026, 8, 13, 12) };
    const scoreboard = new SoloScoreboard({
      store: new MemoryScoreStore(),
      verifier,
      now: () => now.t,
      newSeed: () => FIXTURE.seed,
    });
    const relay = await startRelayWsServer({
      port: 0,
      host: '127.0.0.1',
      http: createScoreboardApi(scoreboard),
    });
    const api = `http://127.0.0.1:${relay.port}/api/solo`;
    const ticket = await fetch(`${api}/ticket`, { method: 'POST' });
    const { runId } = (await ticket.json()) as { runId: string };
    now.t += FIXTURE.ticks * 20;

    const submitting = fetch(`${api}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, name: 'misha', replay: FIXTURE }),
    });
    await vi.waitFor(() => expect(verifier.queued).toBe(1));
    const closing = relay.close();
    release();
    const res = await submitting;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ score: 48 });
    await closing;
  });
});
