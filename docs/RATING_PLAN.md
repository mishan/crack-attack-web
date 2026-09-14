# Multiplayer rating — plan

A rated ladder for netplay: registered players, a rating computed from wins and
losses, and a public leaderboard. Hosted by the relay (`packages/server`)
beside the lobby and the solo scoreboard.

## Starting point

- Identity is a server-minted 128-bit hex token (`SESSION_TOKEN_LENGTH`), sent
  in `hello` and kept in `localStorage` as `crack-attack.token`. It's the
  primary key of `players(token, name, wins, losses)`, stored as is. Names
  aren't unique. A player who clears site data or switches browser loses the
  record, and there's no way to carry it to another device.
- The relay counts a decisive game as a win and a loss (`recordResult`).
  Draws aren't recorded, and neither are games against a bot.
- Outcomes are client-reported. Both clients run both sims and send `result`.
  If the reports agree, the result is recorded. If they disagree, the relay
  treats it as a desync and records nothing. Conceding, leaving mid-match and
  running out the 30 s reconnect grace each record a loss.
- The relay keeps both players' full per-tick input ledgers for the match in
  progress (for reconnects and late spectators) and drops them when it ends.
- Core has no two-board runner. Garbage cross-wiring and step order live in
  the client (`net/lockstep.ts`, `sim/aiVsAi.ts`) and in `tools/ai-arena`.
- The relay's HTTP side (the solo scoreboard) already has per-client rate
  limits, `TRUST_PROXY`, and a time-sliced replay verifier.

## A gap to close first

A losing player can erase a loss today: they report themselves the winner.
The two reports disagree, the relay calls it a desync, and nothing is
recorded. A forged digest does the same. That's tolerable for a W-L curiosity
but not for a rating. [Verified outcomes](#verified-outcomes) closes it.

## Accounts: a key, not a password

A key the player keeps in their password manager works, and it needs no
password or personal details:

- **The server makes the key.** Registration returns a random key phrase: 8
  words from the EFF long wordlist (7,776 words, about 103 bits), joined by
  hyphens. The player never picks it, so it can't be weak or reused from
  another site. It's a random secret, not a password.
- **The server stores only its SHA-256.** A slow password hash (bcrypt,
  Argon2) exists to protect guessable passwords. A random 103-bit key can't be
  guessed from its hash, so a leaked database gives nobody a key. Login finds
  the account by the key's hash.
- **No personal details.** No email, password or real name. As with the
  scoreboard, IP addresses are used only for in-memory rate limits. An account
  is a handle, a key hash and a rating.
- **A lost key can't be recovered.** With nothing else to go on, the server
  can't tell the owner from anyone else. Two mitigations: a logged-in browser
  can replace its key at any time (the old one stops working), and the
  registration screen says plainly that the key _is_ the account.

### Getting it into the password manager

Password managers save what's submitted in a login-shaped form and fill it
back on the same site. So the client uses real forms:

- **Save key** (after registering): a `<form>` with the handle in an
  `autocomplete="username"` field and the key in a `type="password"`,
  `autocomplete="new-password"` field, prefilled, and a **Save key** submit
  button. The form's own submit, followed by the form going away, is what
  makes the manager offer to save. Copy, Download (`.txt`) and Show buttons
  cover players without a manager.
- **Log in:** the same pair of fields, the key with
  `autocomplete="current-password"`, so the manager fills both. The server
  ignores the username: the key alone identifies the account. A saved entry
  with an old handle (after a rename) still works; the handle is there to
  label the entry.
- **The browser's own password suggestion must not replace the key.**
  Browsers offer to generate a strong password for a `new-password` field. If
  the player accepts, the manager would save that instead. On submit, the
  client checks that the field still holds the issued key. If it doesn't, the
  client puts the key back and asks again.
- The API is on the page's own origin (the `/api/` proxy the scoreboard
  already uses). So the saved entry is for the game's domain, and the manager
  won't fill it on a lookalike site.
- Save-prompt detection varies. Test Chrome, Safari and Firefox, 1Password and
  Bitwarden, and iOS and Android autofill before calling this done.

### Sessions

- Logging in trades the key for a session token: the same
  `crack-attack.token` the lobby uses, so `hello` doesn't change. The browser
  keeps only the session, never the key.
- Session tokens are stored hashed too (SHA-256), so a leaked database can't be
  used to log in. A session lasts a year from its last use. **Log out** ends
  it. Replacing the key ends every session except the current one.
- HTTP calls send the session in an `Authorization: Bearer` header, never a
  cookie, so there's no CSRF to defend. Keys and sessions go only in request
  bodies and headers, never in URLs (which end up in logs).

### Guests

Guests stay. A browser without an account keeps today's anonymous identity and
its W-L record, and plays casual games. Creating an account from a guest
session carries the guest's W-L over to the account; the rating starts fresh.
Guest tokens stay as they are, since they only guard a casual record.

### Handles

- Unique, compared case-insensitively after `normalizeScoreName` (the solo
  board's cleanup: 16 graphemes, no control, bidi or zero-width characters).
  Lookalikes across scripts, such as a Cyrillic letter that looks Latin, aren't
  caught; the admin CLI can rename an abusive handle.
- A handle can be changed once every 30 days. The old one becomes free.

### Considered: passkeys

Passkeys (WebAuthn) are the fullest form of this idea: the password manager
holds a key pair, the server holds only the public key, and there's no secret
to phish. They're deferred, not rejected. The relay would need WebAuthn's
binary formats (CBOR, COSE) parsed, which means a new dependency in the
single-file bundle. A passkey can later become a second way to log in to the
same account.

## Rating: Glicko-2

- **Glicko-2, not Elo.** Each player has a rating plus a rating deviation (RD)
  that says how certain it is. A new player's rating moves fast and settles as
  they play; a player back after months moves fast again. It also blunts
  farming: beating an account with a high RD, such as a fresh alt, is worth
  little.
- **Updated after every rated game**, each game its own rating period, as
  Lichess does. RD grows with days idle, applied at the player's next game.
  Start at 1500, RD 350, volatility 0.06; system constant τ = 0.5.
- **Shown as a whole number.** A rating is provisional, shown as `1580?`,
  while its RD is above 110. A same-tick double loss is a draw (½).
- **Floats are fine.** Rating math runs only on the server and never touches
  the sim. Each game stores both players' ratings before and after, so the
  ladder can be recomputed from the game log if the constants change.

## What's rated

A game is rated only if all of these hold:

- The room was created **Rated**. Only a registered player can create one,
  and only registered players can take its seats. Anyone can watch.
- Both seats are human (no bots).
- The pair has played fewer than 10 rated games today (UTC). Later games in
  the room are casual. This limits how much an alt can feed one account.

How each ending is rated:

| Ending                                     | Rated as                        |
| ------------------------------------------ | ------------------------------- |
| Played out, reports agree                  | The verified outcome            |
| Played out, reports disagree, or a desync  | The verified outcome            |
| Concede                                    | A loss for the player conceding |
| Leave mid-match, or the grace runs out     | A loss for the player who left  |
| Verification fails, or disagrees with both | Not rated, and logged           |

## Verified outcomes

The relay already holds everything it needs to decide a match: the seed and
both input ledgers. As with the solo scoreboard, it re-simulates instead of
trusting reports.

- **A two-board runner in core** (`core/netMatch.ts`): two `GameSim`s from one
  seed, garbage cross-wired, the lockstep step order, a same-tick double loss
  as a draw. Lockstep, the spectator and `ai-arena` move onto it, so "who won"
  has one definition. A golden fixture pins it.
- **Verified at match end.** When a rated game plays out, or any game
  desyncs, the relay copies the seed and both ledgers before clearing them. It
  queues the copy on the solo verifier's queue, generalized to both kinds of
  job: one job at a time, in 2000-tick slices, so netplay never stalls. A
  10-minute game is 60,000 sim steps across both boards, about 130 ms in
  total at the measured 450k ticks/s.
- **The result screen doesn't wait.** Clients still end the match on their
  reports. The rating change follows a moment later in a new `rating_update`
  message.
- **Casual disputes are verified too.** They're rare, and verifying them ends
  the loss-erasing trick everywhere, not just on the ladder.
- **What this can't stop:** a bot sending real inputs in real time, as with
  solo. Stored games let anyone watch a suspicious climb once the replay viewer
  exists.

## Matchmaking

Once ratings exist, a rating-matched queue is the natural way to find a rated
game. It comes after the ladder ships. Rated lobby rooms stay, for challenging
a friend, and the pair cap applies to both.

- **Play rated** in the lobby joins the queue. It's for registered players
  only.
- **Pairing:** the relay pairs the two waiting players whose ratings are
  closest, as long as the gap is inside both players' windows. A window starts
  at ±100 and widens by 50 for every 10 s waited, so a quiet queue still finds
  someone.
- **No rematch through the queue:** the queue doesn't pair the same two
  players twice in a row while anyone else is waiting. It never pairs them
  once they've reached today's cap.
- **Accept:** a found match gives both players 10 s to accept. A player who
  doesn't accept leaves the queue. The other goes back in, keeping their time
  waited.
- **Then a normal rated room:** the relay seats both players in a new rated
  room and starts the countdown. Rematches in that room are rated as usual,
  within the cap. **Queue again** goes back to the queue.
- **A small player base:** the lobby shows how many players are queued
  ("2 looking for a rated game"), so one waiting player draws others in.
- **Memory only:** like rooms, the queue lives in the relay's memory, so a
  restart empties it. Disconnecting leaves the queue; there's no reconnect
  grace for it.
- **Protocol v6:** `queue_join`, `queue_leave`, `queue_status` (players queued,
  time waited, current window), `match_found` (the opponent, their rating, the
  accept deadline) and `queue_accept`.

## Storage

The scoreboard hasn't been deployed, so these tables go into migration 1
beside `solo_tickets` and `solo_scores`. If the scoreboard ships first, they
become migration 2. `players` doesn't change.

- `accounts(id PK, handle, handle_folded UNIQUE, key_hash UNIQUE, rating, rd, volatility, rated_at, wins, losses, draws, created_at, renamed_at, hidden)`
- `sessions(token_hash PK, account_id, last_used_at)`
- `rated_games(id PK, account_a, account_b, result, end_reason, ticks, seed, sim_version, a_before, a_after, b_before, b_after, created_at, inputs)`:
  ratings before and after are (rating, RD) pairs. `inputs` holds both
  ledgers change-encoded like solo replays, a few KB. It's kept by the solo
  retention rule (a week, then only notable games), for a later replay viewer.

## API

Over HTTP beside `/api/solo`, with the scoreboard's rate limits and
`TRUST_PROXY`:

| Route                            | What it does                                                          |
| -------------------------------- | --------------------------------------------------------------------- |
| `POST /api/account/register`     | `{handle, guestToken?}` → `{key, session, account}`, tight per-IP cap |
| `POST /api/account/login`        | `{key}` → `{session, account}`                                        |
| `POST /api/account/key`          | Session → a new key; ends every other session                         |
| `POST /api/account/logout`       | Ends this session                                                     |
| `POST /api/account/delete`       | `{key}` → deletes the account; its games show "deleted player"        |
| `GET /api/rating/leaderboard`    | Non-provisional accounts active in the last 30 days, by rating        |
| `GET /api/rating/player/:handle` | Rating, RD, W-L-D and recent rated games                              |

Deleting needs the key, not just a session, so a borrowed logged-in browser
can't delete the account.

The WebSocket protocol (v5): `hello` is unchanged, carrying a session or guest
token. `welcome` and the room list carry each player's rating (null for
guests) and a room's `rated` flag; `create_room` takes `rated`; `rating_update`
follows a rated game.

Moderation: `relay.mjs admin` gains `account <handle>`, `rename <handle> <new>`,
`hide-account <handle>` and `reset-rating <handle>`.

## Client

- **Account screen**, from the lobby: **Create account** (pick a handle, then
  the Save key form), **Log in**, and once logged in the handle, rating,
  **Replace key**, **Log out** and **Delete account**.
- **Lobby:** ratings beside names, a **Rated** checkbox when creating a room
  (on by default for accounts), and rated rooms marked. Guests can watch them.
- **Result banner:** the rating change (`+14 → 1594`) once verified.
- **Leaderboard screen**, like High scores.
- **Play rated** (with matchmaking): the queue's status, the match-found
  accept prompt, and **Queue again** after a game.

## Phases

Each phase is one PR.

1. **core:** `netMatch.ts`, with lockstep, spectator and `ai-arena` moved onto
   it; a golden fixture.
2. **server:** verify disputed and desynced games. This closes the gap on its
   own, before any accounts exist.
3. **server:** accounts, sessions, the account API, handles, admin commands.
4. **server:** rated rooms, Glicko-2, the game log, the leaderboard API,
   protocol v5.
5. **client:** account screens (and the password-manager test matrix), rated
   lobby, leaderboard.
6. **docs and deploy:** the ladder ships.
7. **server and client:** [matchmaking](#matchmaking): the queue, pairing,
   accept, protocol v6, and its docs.

## Decisions

1. **Key format:** 8 words from the EFF long wordlist (about 103 bits), not
   random characters. It's longer, but easier to read and to type from a
   phone.
2. **Finding opponents:** rated lobby rooms first, then a rating-matched queue
   ([Matchmaking](#matchmaking)).
3. **Numbers:** at most 10 rated games per pair per UTC day; the leaderboard
   lists accounts active in the last 30 days; a rating is provisional while
   its RD is above 110.
