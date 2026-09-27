/**
 * accountState.ts — which identity this browser plays as, in localStorage.
 *
 * The lobby's token (`crack-attack.token`) is a guest's token or, once logged
 * in, the account's session: the relay tells them apart, and `hello` carries
 * either. Beside it the browser keeps the account's handle while logged in,
 * and, when a guest logs in to an existing account, the guest's own token, so
 * logging out returns to that guest and its record. Registering moves the
 * guest's record into the new account, so there's no guest to return to.
 *
 * The browser never stores the key: only the session it was traded for.
 */

import { isSessionToken } from '@crack-attack/protocol';

export const STORAGE_TOKEN = 'crack-attack.token';
const STORAGE_HANDLE = 'crack-attack.account';
const STORAGE_GUEST = 'crack-attack.guestToken';

/** The part of `Storage` used here. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The page's localStorage, or null where it's unavailable (blocked, or not a browser). */
export function browserStorage(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class AccountState {
  constructor(private readonly storage: KeyValueStore | null) {}

  /** The token the lobby's `hello` carries: a guest's, or the account's session. */
  get token(): string | null {
    return this.get(STORAGE_TOKEN);
  }

  /** The account's handle while logged in; null for a guest. */
  get handle(): string | null {
    return this.get(STORAGE_HANDLE);
  }

  /** The session, while logged in. */
  get session(): string | null {
    return this.handle === null ? null : this.token;
  }

  /** A guest token whose record a new account should take over, if there is one. */
  guestTokenForRegistration(): string | undefined {
    const token = this.token;
    return this.handle === null && token !== null && isSessionToken(token) ? token : undefined;
  }

  /** A new account, logged in: the guest it was made from is gone. */
  registered(session: string, handle: string): void {
    this.set(STORAGE_TOKEN, session);
    this.set(STORAGE_HANDLE, handle);
    this.remove(STORAGE_GUEST);
  }

  /** Logged in to an existing account: the guest waits for the log out. */
  loggedIn(session: string, handle: string): void {
    const guest = this.handle === null ? this.token : null;
    if (guest !== null) this.set(STORAGE_GUEST, guest);
    this.set(STORAGE_TOKEN, session);
    this.set(STORAGE_HANDLE, handle);
  }

  /** The handle changed (a rename). */
  renamed(handle: string): void {
    if (this.handle !== null) this.set(STORAGE_HANDLE, handle);
  }

  /** Logged out, or the account is gone: back to the guest, if there was one. */
  loggedOut(): void {
    const guest = this.get(STORAGE_GUEST);
    if (guest !== null) this.set(STORAGE_TOKEN, guest);
    else this.remove(STORAGE_TOKEN);
    this.remove(STORAGE_GUEST);
    this.remove(STORAGE_HANDLE);
  }

  /**
   * The lobby's `welcome`: the relay's token for this connection, and whether
   * it's an account. True when a relay met this browser's session as a guest:
   * then nothing is stored, and the caller should ask the account API whether
   * the session has ended (and if so call {@link loggedOut}) rather than take
   * the relay's word for it. A relay without accounts (a dev relay, one on an
   * older database) knows no sessions at all.
   */
  welcomed(token: string, account: boolean): boolean {
    if (!account && this.handle !== null) return true;
    this.set(STORAGE_TOKEN, token);
    return false;
  }

  private get(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private set(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // Full or blocked: the identity lasts only for this page.
    }
  }

  private remove(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch {
      // As above.
    }
  }
}
