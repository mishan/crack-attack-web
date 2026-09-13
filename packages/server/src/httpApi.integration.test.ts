/**
 * Integration: the scoreboard's HTTP routes on the relay's real HTTP server,
 * beside its WebSocket, on an ephemeral port.
 */

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { SoloReplay } from '@crack-attack/core';
import { PROTOCOL_VERSION, SOLO_SUBMIT_MAX_BYTES, encodeMessage } from '@crack-attack/protocol';
import { createScoreboardApi } from './httpApi.js';
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
    expect(((await replayRes.json()) as { replay: unknown }).replay).toEqual(FIXTURE);
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
