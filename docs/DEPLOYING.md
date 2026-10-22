# Deploying

This sets up the whole game on one Linux server. nginx serves the game's files
over HTTPS and passes two paths to the relay: `/ws` for netplay and `/api/` for
the solo scoreboard, accounts and the rated leaderboard. The relay runs as a
systemd service and keeps its data in one SQLite file.

HTTPS isn't optional. A page served over `https://` may only open `wss://`
WebSockets, and the relay speaks plain WebSocket, so nginx handles TLS in front
of it.

You need:

- A Linux server with systemd, and a domain name pointing at it. The examples
  use `example.com`; replace it throughout.
- On the server: Node 22.13 or newer, nginx and certbot. Node only runs the
  relay; nothing is built on the server.
- On your own machine: this repo, set up as in [Install](../README.md#install).

## 1. Build

On your machine, from the repo root:

```sh
pnpm install
pnpm --filter @crack-attack/server bundle
node packages/server/scripts/smoke-bundle.mjs
VITE_RELAY_URL=wss://example.com/ws VITE_PUBLIC_URL=https://example.com/ \
  pnpm --filter @crack-attack/client build
```

That makes the two things to copy to the server:

- `packages/server/dist/relay.mjs`: the relay, in one file. It includes the
  game and its one dependency and uses Node's built-in SQLite, so the server
  needs no `node_modules`. The smoke test runs it alone in an empty directory
  to make sure.
- `packages/client/dist/web/`: the game, as static files.

`VITE_RELAY_URL` is the address browsers use to reach the relay, fixed at build
time. The client finds the relay's HTTP API from it: `wss://example.com/ws` →
`https://example.com/api/…`.

`VITE_PUBLIC_URL` is the game's own address. Link previews on Facebook,
LinkedIn and the like need the game's preview image as a full URL, so the build
adds it only when this is set. Without it, shared links still work, with a
preview that has no picture.

## 2. Install the relay

Copy `relay.mjs` to the server (with `scp`, say). Then, on the server, create a
user for the relay and put the file in place:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin crack-attack
sudo install -D -m 644 relay.mjs /opt/crack-attack/relay.mjs
```

Create `/etc/systemd/system/crack-attack.service`:

```ini
[Unit]
Description=Crack Attack! relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/crack-attack/relay.mjs
WorkingDirectory=/opt/crack-attack
Environment=HOST=127.0.0.1 PORT=8080 TRUST_PROXY=1 DB=/var/lib/crack-attack/lobby.db PUBLIC_URL=https://example.com/
StateDirectory=crack-attack
User=crack-attack
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

- `HOST=127.0.0.1` keeps the relay's unencrypted port closed to the outside;
  only nginx reaches it.
- `TRUST_PROXY=1` tells the relay that nginx is in front. The scoreboard limits
  requests per player. Without this setting every request seems to come from
  nginx, so all players share one limit.
- `DB` is the database: guests' records, accounts and the rated-game log, and
  the scoreboard. `StateDirectory` has systemd create `/var/lib/crack-attack`
  for the relay's user, and the relay creates the file on first start.
- `PUBLIC_URL` is the game's address. When a player shares a ranked score,
  the link goes to a page the relay serves, and Facebook, LinkedIn and Bluesky
  show that page's preview, score included. The page uses this address for the
  preview image and to send visitors on to the game.
- If `which node` doesn't print `/usr/bin/node`, change `ExecStart` to match.

Start the relay, and have it start at boot:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now crack-attack
journalctl -u crack-attack -n 20
```

The log should end with
`crack-attack relay listening on :8080 (db: /var/lib/crack-attack/lobby.db)`.
On Node 22 there's also a one-time `ExperimentalWarning` about SQLite, which is
harmless.

## 3. Upload the game

On the server, create the directory nginx will serve, owned by your login:

```sh
sudo mkdir -p /var/www/crack-attack
sudo chown "$USER" /var/www/crack-attack
```

Then, from your machine, copy the contents of `packages/client/dist/web/` into
it:

```sh
rsync -a packages/client/dist/web/ example.com:/var/www/crack-attack/
```

## 4. Configure nginx

This config serves the game over plain HTTP for now; the next step adds HTTPS.
Save it as `/etc/nginx/sites-available/crack-attack` (on Debian and Ubuntu;
other distributions use `/etc/nginx/conf.d/crack-attack.conf`):

```nginx
server {
  listen 80;
  server_name example.com;

  # The game's files, from step 3.
  root /var/www/crack-attack;

  # Netplay: the relay's WebSocket.
  location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    # The relay doesn't send heartbeats yet, so an idle lobby connection is
    # silent. Keep it open longer than nginx's 60 s default.
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }

  # The HTTP API: the solo scoreboard, accounts and the leaderboard.
  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    # Each player's address, for the scoreboard's limits (TRUST_PROXY=1).
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # http or https, for score share pages' links if PUBLIC_URL isn't set.
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # These file names change whenever their contents do, so browsers can keep
  # them for good.
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # Always check for a new index.html, so an update shows up at once.
  location = /index.html {
    add_header Cache-Control "no-cache";
  }

  # The game's JavaScript is ~700 kB, ~185 kB compressed.
  gzip on;
  gzip_types application/javascript model/gltf+json;
}
```

On Debian and Ubuntu, enable it (the `conf.d` file needs no link), then reload
nginx:

```sh
sudo ln -s /etc/nginx/sites-available/crack-attack /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Turn on HTTPS

```sh
sudo certbot --nginx -d example.com
```

Certbot gets a free certificate from Let's Encrypt, adds HTTPS to the server
block above, and renews the certificate automatically. If it asks, have it
redirect HTTP to HTTPS.

## 6. Check it

```sh
curl -s -X POST https://example.com/api/solo/ticket    # {"runId":…,"seed":…,…}
curl -s 'https://example.com/api/solo/scores?limit=5'  # includes "total":0 until someone plays
curl -s https://example.com/api/rating/leaderboard     # {"entries":[]} until ratings settle
```

Then open `https://example.com/`. The title card and an AI match should appear.
Press a key to play solo; the HUD should say `RANKED`. **Play online** should
open the lobby, and **Account** there the account screen.

If something's wrong:

- **nginx answers 502 Bad Gateway:** the relay isn't running. Look at
  `journalctl -u crack-attack`.
- **Solo says `UNRANKED — offline`, or Play online can't connect:** check that
  the `VITE_RELAY_URL` in step 1 matches your domain, then rebuild and upload
  the game again.

## Running it

- **Logs:** `journalctl -u crack-attack`. A line starting `scoreboard:` or
  `accounts:` means a limit shared by all players is turning requests away (if
  it's the ticket limit, everyone is playing unranked) or a background cleanup
  failed. `relay: disputed …` is a game whose players disagreed, and what the
  replay decided; `relay: unsettled …` is a rated game the replay couldn't
  settle, so it wasn't rated. A few are noise; a steady stream from one
  player is worth a look with `admin account`.
- **Moderation:** run the [admin commands](RELAY.md#solo-scoreboard) (and the
  [account ones](RELAY.md#accounts)) as the relay's user, so any file SQLite creates
  beside the database stays the relay's:

  ```sh
  sudo -u crack-attack env DB=/var/lib/crack-attack/lobby.db node /opt/crack-attack/relay.mjs admin recent 50
  sudo -u crack-attack env DB=/var/lib/crack-attack/lobby.db node /opt/crack-attack/relay.mjs admin account misha
  ```

- **Backups:** the database is the only data to keep, and it holds every
  account. A key can't be recovered, so a lost database is every account
  gone for good: back it up daily, and keep a copy off the server. Copy it
  with `sqlite3` (from the `sqlite3` package), which is safe while the relay
  runs; a plain `cp` can miss recent writes:

  ```sh
  sudo -u crack-attack sqlite3 /var/lib/crack-attack/lobby.db ".backup /var/lib/crack-attack/backup.db"
  ```

  Keys and sessions are stored only as hashes, so a leaked backup logs nobody
  in; it does hold handles, ratings and game logs, so keep it private anyway.

- **Updating:** take a backup, rebuild as in step 1, copy the new `relay.mjs`
  into place, `sudo systemctl restart crack-attack`, then upload the new game
  files. The relay upgrades the database itself on start. Restarting ends any
  match in progress, and when the netplay protocol has changed, players with
  the old page open are turned away from the lobby until they reload.

- **Stopping:** `sudo systemctl stop crack-attack` shuts the relay down
  cleanly. Rooms live in memory, so any match in progress ends.

## Other setups

- **The relay on its own host or subdomain:** build with
  `VITE_RELAY_URL=wss://relay.example.com/ws` and give that host the same
  `/ws` and `/api/` locations. The API is then on a different origin from the
  game, so add `CORS_ORIGIN=https://example.com` (the game's address) to the
  relay's `Environment=` line. Account keys are saved by password managers for
  the game's own domain, so they fill in wherever the game is served from.
- **The game on another web server or a static host:** upload the contents of
  `dist/web` anywhere, at the domain root or in a subdirectory (asset paths
  are relative), with the caching and compression from the config above. It
  must be served over HTTP(S); opening `index.html` from disk won't load it.
  Without a relay, solo still plays, unranked.
- **A CDN in front of nginx:** set `TRUST_PROXY=2`, so the relay uses the
  address the CDN saw rather than the CDN's own. nginx must then accept
  connections only from the CDN: firewall it to the CDN's address ranges, or
  use the CDN's authenticated origin pulls. Otherwise a client could reach
  nginx directly with a made-up `X-Forwarded-For` header and pick its own
  address for the limits.
