/**
 * accounts.ts — the account service, transport-free (see docs/RATING_PLAN.md
 * and protocol `account.ts`). The HTTP routes (`httpApi.ts`) are a thin
 * wrapper, as for the scoreboard.
 *
 * An account's key is eight random words the server picks, so it can't be
 * weak or reused from another site. It's a random 103-bit secret, not a
 * password, so it's stored as a plain SHA-256: a slow hash only helps against
 * guessable secrets, and nobody can guess this one from its hash. Session
 * tokens are stored hashed the same way, so a leaked database logs nobody in.
 * There is nothing else to recover an account by: the key _is_ the account.
 */

import {
  ACCOUNT_KEY_WORDS,
  HANDLE_RENAME_INTERVAL_MS,
  PROVISIONAL_RD,
  ProtocolError,
  SESSION_TOKEN_LENGTH,
  SESSION_TTL_MS,
  decodeAccountHandleRequest,
  decodeAccountKeyRequest,
  decodeAccountRegisterRequest,
  foldHandle,
  isSessionToken,
  normalizeAccountKey,
  normalizeHandle,
  type AccountInfo,
  type AccountKeyResponse,
  type AccountRegisterResponse,
  type AccountResponse,
  type AccountSessionResponse,
} from '@crack-attack/protocol';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { AccountStore, StoredAccount } from './accountStore.js';
import { ApiError, TieredLimit, take } from './apiError.js';
import { RateLimiter, type RateLimit } from './rateLimit.js';
import { KEY_WORDS } from './wordlist.js';

/** Registrations per client: a few (a household), then one an hour. */
export const DEFAULT_REGISTER_LIMIT: RateLimit = { capacity: 5, refillMs: 60 * 60 * 1000 };
/** Registrations per IPv6 /48: 20, then one every 15 minutes. */
export const DEFAULT_REGISTER_SITE_LIMIT: RateLimit = { capacity: 20, refillMs: 15 * 60 * 1000 };
/** Registrations across all clients: 100, then one every 10 s. */
export const DEFAULT_REGISTER_GLOBAL_LIMIT: RateLimit = { capacity: 100, refillMs: 10_000 };
/**
 * Requests carrying a key (log in, delete) per client: 10, then one every
 * 30 s. Guessing a key is hopeless at any rate; this keeps it cheap to refuse.
 */
export const DEFAULT_KEY_LIMIT: RateLimit = { capacity: 10, refillMs: 30_000 };
/**
 * Key requests per IPv6 /48: 40, then one every 7.5 s. There's no limit
 * shared by all clients: guessing a key is hopeless anyway, and a shared
 * bucket would let a few hundred addresses lock everyone out of logging in.
 */
export const DEFAULT_KEY_SITE_LIMIT: RateLimit = { capacity: 40, refillMs: 7_500 };
/** Requests with a session (who am I, rename, new key, log out) per client: 60, then one a second. */
export const DEFAULT_SESSION_LIMIT: RateLimit = { capacity: 60, refillMs: 1_000 };

/** Stale sessions are swept at most this often (on the next log in or registration). */
const PRUNE_EVERY_MS = 60 * 60 * 1000;
/** A shared limit turning requests away is logged at most this often. */
const SHARED_LIMIT_LOG_EVERY_MS = 10 * 60 * 1000;

export interface AccountServiceOptions {
  store: AccountStore;
  /** Wall clock in epoch ms. Inject for tests. */
  now?: (() => number) | undefined;
  /** Key source; defaults to eight CSPRNG-picked words. Inject for tests. */
  newKey?: (() => string) | undefined;
  /** Session token source; defaults to a CSPRNG. Inject for tests. */
  newSession?: (() => string) | undefined;
  /** Operator warnings (a shared limit refusing requests); defaults to `console.warn`. */
  log?: ((line: string) => void) | undefined;
  registerLimit?: RateLimit | undefined;
  registerSiteLimit?: RateLimit | undefined;
  registerGlobalLimit?: RateLimit | undefined;
  keyLimit?: RateLimit | undefined;
  keySiteLimit?: RateLimit | undefined;
  sessionLimit?: RateLimit | undefined;
}

/** A new account key: {@link ACCOUNT_KEY_WORDS} words from the EFF long wordlist, hyphenated. */
export function generateAccountKey(): string {
  const words: string[] = [];
  for (let i = 0; i < ACCOUNT_KEY_WORDS; i++) words.push(KEY_WORDS[randomInt(KEY_WORDS.length)]!);
  return words.join('-');
}

/** The stored form of a key or session token: its SHA-256, in hex. */
export function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** An account as its owner sees it. */
export function accountInfo(account: StoredAccount): AccountInfo {
  return {
    handle: account.handle,
    rating: Math.round(account.rating),
    provisional: account.rd > PROVISIONAL_RD,
    wins: account.wins,
    losses: account.losses,
    draws: account.draws,
    createdAt: account.createdAt,
    renameAt:
      account.renamedAt === null
        ? account.createdAt
        : account.renamedAt + HANDLE_RENAME_INTERVAL_MS,
  };
}

export class AccountService {
  private readonly store: AccountStore;
  private readonly now: () => number;
  private readonly newKey: () => string;
  private readonly newSession: () => string;
  private readonly log: (line: string) => void;
  private readonly registerLimit: TieredLimit;
  private readonly keyLimit: TieredLimit;
  private readonly sessionLimiter: RateLimiter;
  /** Requests each shared limit has refused since it was last logged. */
  private readonly sharedRefusals = new Map<string, { count: number; loggedAt: number }>();
  private lastPrune = -Infinity;

  constructor(options: AccountServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.newKey = options.newKey ?? generateAccountKey;
    this.newSession =
      options.newSession ?? (() => randomBytes(SESSION_TOKEN_LENGTH / 2).toString('hex'));
    this.log = options.log ?? ((line) => console.warn(line));
    this.registerLimit = new TieredLimit(
      [
        options.registerLimit ?? DEFAULT_REGISTER_LIMIT,
        options.registerSiteLimit ?? DEFAULT_REGISTER_SITE_LIMIT,
        options.registerGlobalLimit ?? DEFAULT_REGISTER_GLOBAL_LIMIT,
      ],
      this.now,
      () => this.sharedRefusal('registration'),
    );
    this.keyLimit = new TieredLimit(
      [options.keyLimit ?? DEFAULT_KEY_LIMIT, options.keySiteLimit ?? DEFAULT_KEY_SITE_LIMIT, null],
      this.now,
      () => this.sharedRefusal('key'),
    );
    this.sessionLimiter = new RateLimiter(options.sessionLimit ?? DEFAULT_SESSION_LIMIT, this.now);
  }

  /**
   * Create an account for `client` (a rate-limit key, see `clientKey`) and log
   * it in. A guest token in the request moves that guest's W-L record over.
   */
  async register(client: string, body: unknown): Promise<AccountRegisterResponse> {
    this.registerLimit.take(client);
    const request = decode(() => decodeAccountRegisterRequest(body));
    const handle = this.handle(request.handle);
    const key = this.newKey();
    const session = this.newSession();
    const now = this.now();
    const account = await this.store.createAccount({
      handle,
      handleFolded: foldHandle(handle),
      keyHash: secretHash(key),
      sessionHash: secretHash(session),
      createdAt: now,
      guestToken: request.guestToken,
    });
    if (!account) throw handleTaken(handle);
    await this.prune(now);
    return { key, session, account: accountInfo(account) };
  }

  /** Trade a key for a new session. */
  async login(client: string, body: unknown): Promise<AccountSessionResponse> {
    this.keyLimit.take(client);
    const account = await this.byKey(decode(() => decodeAccountKeyRequest(body)).key);
    const session = this.newSession();
    const now = this.now();
    await this.store.addSession(secretHash(session), account.id, now);
    await this.prune(now);
    return { session, account: accountInfo(account) };
  }

  /** The account an `Authorization` header's session belongs to. */
  async me(client: string, authorization: string | undefined): Promise<AccountResponse> {
    const { account } = await this.session(client, authorization);
    return { account: accountInfo(account) };
  }

  /** Change the session's account's handle, at most once per {@link HANDLE_RENAME_INTERVAL_MS}. */
  async rename(
    client: string,
    authorization: string | undefined,
    body: unknown,
  ): Promise<AccountResponse> {
    const { account } = await this.session(client, authorization);
    const handle = this.handle(decode(() => decodeAccountHandleRequest(body)).handle);
    if (handle === account.handle) return { account: accountInfo(account) };
    const now = this.now();
    const renameAt = accountInfo(account).renameAt;
    if (now < renameAt) {
      throw new ApiError(
        409,
        'rename_too_soon',
        `the handle can next be changed at ${new Date(renameAt).toISOString()}`,
      );
    }
    const renamed = await this.store.renameAccount(account.id, handle, foldHandle(handle), now);
    if (!renamed) throw handleTaken(handle);
    return { account: accountInfo(renamed) };
  }

  /**
   * Give the session's account a new key, ending every other session. It takes
   * the current key as well as the session: a session alone that could mint a
   * key would be a stolen browser's way to take (and then delete) the account.
   */
  async replaceKey(
    client: string,
    authorization: string | undefined,
    body: unknown,
  ): Promise<AccountKeyResponse> {
    const { account, sessionHash } = await this.session(client, authorization);
    this.keyLimit.take(client);
    const current = await this.byKey(decode(() => decodeAccountKeyRequest(body)).key);
    if (current.id !== account.id) throw otherAccountsKey();
    const key = this.newKey();
    await this.store.replaceKey(account.id, secretHash(key), sessionHash);
    return { key };
  }

  /** End the session, if it exists. */
  async logout(client: string, authorization: string | undefined): Promise<Record<string, never>> {
    take(this.sessionLimiter, client);
    await this.store.endSession(secretHash(bearer(authorization)));
    return {};
  }

  /**
   * Delete the account a key belongs to. It takes the key, not just a session,
   * so a borrowed logged-in browser can't delete the account. Sent with a
   * session, the key must be that session's account's: a password manager
   * offering the wrong saved entry mustn't delete another account.
   */
  async deleteAccount(
    client: string,
    authorization: string | undefined,
    body: unknown,
  ): Promise<Record<string, never>> {
    const own =
      authorization === undefined ? null : (await this.session(client, authorization)).account;
    this.keyLimit.take(client);
    const account = await this.byKey(decode(() => decodeAccountKeyRequest(body)).key);
    if (own && own.id !== account.id) throw otherAccountsKey();
    await this.store.deleteAccount(account.id);
    return {};
  }

  /** A requested handle, cleaned up; a 400 if nothing usable is left. */
  private handle(raw: string): string {
    const handle = normalizeHandle(raw);
    if (handle === null)
      throw new ApiError(400, 'bad_handle', 'a handle needs a visible character');
    return handle;
  }

  private async byKey(raw: string): Promise<StoredAccount> {
    const key = normalizeAccountKey(raw);
    const account = key === null ? null : await this.store.accountByKey(secretHash(key));
    if (!account) throw new ApiError(401, 'bad_key', 'no account has that key');
    return account;
  }

  private async session(
    client: string,
    authorization: string | undefined,
  ): Promise<{ account: StoredAccount; sessionHash: string }> {
    take(this.sessionLimiter, client);
    const sessionHash = secretHash(bearer(authorization));
    const now = this.now();
    const account = await this.store.useSession(sessionHash, now, now - SESSION_TTL_MS);
    if (!account) throw unauthorized();
    return { account, sessionHash };
  }

  /** Sweep stale sessions, at most every {@link PRUNE_EVERY_MS}. */
  private async prune(now: number): Promise<void> {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    await this.store.pruneSessions(now - SESSION_TTL_MS);
  }

  private sharedRefusal(what: string): void {
    const now = this.now();
    const seen = this.sharedRefusals.get(what) ?? { count: 0, loggedAt: -Infinity };
    seen.count++;
    this.sharedRefusals.set(what, seen);
    if (now >= seen.loggedAt && now - seen.loggedAt < SHARED_LIMIT_LOG_EVERY_MS) return;
    this.log(
      `accounts: the ${what} limit shared by all clients refused ${seen.count} ` +
        `request${seen.count === 1 ? '' : 's'} (reported at most every ` +
        `${SHARED_LIMIT_LOG_EVERY_MS / 60_000} min)`,
    );
    seen.count = 0;
    seen.loggedAt = now;
  }
}

/** The session token in an `Authorization: Bearer` header; a 401 if there isn't one. */
function bearer(authorization: string | undefined): string {
  const match = /^Bearer +(\S+)\s*$/i.exec(authorization ?? '');
  if (!match || !isSessionToken(match[1]!)) throw unauthorized();
  return match[1]!;
}

function decode<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof ProtocolError) throw new ApiError(400, 'bad_request', err.message);
    throw err;
  }
}

function unauthorized(): ApiError {
  return new ApiError(401, 'unauthorized', 'log in again', { 'WWW-Authenticate': 'Bearer' });
}

function otherAccountsKey(): ApiError {
  return new ApiError(401, 'bad_key', "that key is another account's");
}

function handleTaken(handle: string): ApiError {
  return new ApiError(409, 'handle_taken', `${JSON.stringify(handle)} is taken`);
}
