import { describe, expect, it } from 'vitest';
import { httpOrigin } from './scoreboardDriver.js';

describe('httpOrigin', () => {
  it("maps a relay's WebSocket URL to its HTTP origin, dropping the WebSocket's path", () => {
    expect(httpOrigin('wss://relay.example.com/ws')).toBe('https://relay.example.com');
    expect(httpOrigin('ws://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(httpOrigin('ws://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
  });
});
