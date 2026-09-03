# Sofia Client

A React + TypeScript chat client for agents that implement the [A2A protocol](https://google.github.io/A2A/).

Runs in two modes selectable via environment variable:

| Mode | Description |
|------|-------------|
| **debug** | Direct agent connection by URL — no backend, no database. Ideal for local development and agent testing. |
| **production** | Full-stack mode: Express backend, PostgreSQL, access control, authentication, agent dropdown. Ready for Cloud Run. |

---

## Requirements

- Node.js ≥ 20
- npm ≥ 9
- PostgreSQL ≥ 14 *(production mode only)*

---

## Quick start — debug mode

```bash
# Install all dependencies (frontend + backend in one step)
npm install

# Start the Vite dev server on http://localhost:5173
npm run dev
```

In debug mode the app connects to any A2A agent by URL. No backend or database is required.

---

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```bash
cp .env.example .env
```

### Key variables

| Variable | Values | Description |
|----------|--------|-------------|
| `VITE_MODE` | `debug` \| `production` | Selects the UI and backend behaviour. Embedded in the React bundle at build time. |
| `VITE_AUTH_MODE` | `none` \| `app` \| `user` | Authentication mode (production only). |
| `VITE_BASE` | `/` \| `/a/` \| … | Base path when served under a sub-path (e.g. `/a/`). Must end with `/`. **Build-time** — pass as `--build-arg VITE_BASE=/a/` in Docker. Must match `BASE_PATH`. |
| `PORT` | `3000` | Express server port. |
| `BASE_PATH` | `` \| `/a` | Runtime base path prefix. Set to the same path as `VITE_BASE` (without trailing slash). Required when behind a path-based load balancer. |
| `SESSION_SECRET` | random string | Required when `VITE_AUTH_MODE` ≠ `none`. |
| `SESSION_TIMEOUT_MINUTES` | `30` | Inactivity session timeout. |
| `DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD` | — | PostgreSQL connection (production only). |

> `VITE_*` variables are **build-time** — they are compiled into the JavaScript bundle by Vite. Runtime variables (`BASE_PATH`, `DB_*`, `SESSION_SECRET`, `PORT`) are read by the Express server at startup.

> **Base path pairing**: `VITE_BASE` and `BASE_PATH` must always be set together.  
> `VITE_BASE=/a/` → assets served at `/a/assets/…` and API calls go to `/a/api/…`.  
> `BASE_PATH=/a` → Express mounts routes at `/a/api/…`.

---

## Production mode

### 1 — Database setup

```bash
psql -d <your_db> -f server/migrations/001_init.sql
```

Creates the following tables:

| Table | Purpose |
|-------|---------|
| `sf_user` | Users and apps that can authenticate |
| `sf_agents_config` | Agent name → URL + optional API key |
| `sf_agents_access` | Per-user agent access + profile |
| `sf_app_tokens` | One-time tokens for app-to-app auth |
| `sf_sessions` | Server-side sessions (managed by `connect-pg-simple`) |

### 2 — Authentication modes

#### `VITE_AUTH_MODE=none`
No login. All agents in `sf_agents_config` are accessible.

#### `VITE_AUTH_MODE=user`
Standard login form. Users authenticate with `user_id` + password.  
Credentials are stored in `sf_user` (type `user`, `pwd_hash` = bcrypt hash).

#### `VITE_AUTH_MODE=app`
App-to-app authentication. Two identities are involved:

| Identity | Field | Purpose |
|----------|-------|---------|
| **App credential** | `app_name` + `user_id` + `password` | Authentication only — validated against `sf_user`, never exposed to agents |
| **Caller identity** | `caller_user_id` + `caller_profile` | The end-user of the calling app — displayed in the Sofia header and injected into every agent message as metadata |

**Flow:**

1. External app calls `POST /api/auth/app-login` (server-to-server):
   ```json
   {
     "app_name":       "crm",
     "user_id":        "crm-svc",
     "password":       "...",
     "caller_user_id": "mario.rossi",
     "caller_profile": { "role": "agent", "tenant": "acme" }
   }
   ```
   Returns `{ "token": "<one-time-token>" }`.

2. External app navigates the user's browser to:
   ```
   https://sofia.example.com/?app_token=<token>
   ```

3. Sofia exchanges the token for a session cookie. The token is single-use and expires in 5 minutes.

**What agents receive in every message:**
```json
{
  "params": {
    "message": {
      "parts": [...],
      "metadata": {
        "user_id":  "mario.rossi",
        "app_name": "crm",
        "profile":  { "role": "agent", "tenant": "acme" }
      }
    }
  }
}
```

**Header bar** shows: `crm / mario.rossi`

##### Simulate the app login locally

```bash
# Minimal — local dev (Express :3000 for API, Vite :5173 for the browser)
node scripts/simulate-app-login.js ^
  --password       secret ^
  --caller-user-id mario.rossi ^
  --browser-url    http://localhost:5173

# Full options (Windows cmd)
node scripts/simulate-app-login.js ^
  --url            http://localhost:3000 ^
  --browser-url    http://localhost:5173 ^
  --app-name       crm ^
  --user-id        crm-svc ^
  --password       s3cr3t ^
  --caller-user-id mario.rossi ^
  --caller-profile "{\"role\":\"agent\",\"tenant\":\"acme\"}"

# Print URL without opening the browser (CI / headless servers)
node scripts/simulate-app-login.js ^
  --password secret --caller-user-id mario.rossi ^
  --browser-url http://localhost:5173 --no-open

# Password via env var (avoids it appearing in shell history)
set SOFIA_APP_PASSWORD=secret
node scripts/simulate-app-login.js --caller-user-id mario.rossi --browser-url http://localhost:5173

# Against the internal LB (path-based routing, e.g. /a)
# --url and --browser-url both point to the LB base path

set NODE_TLS_REJECT_UNAUTHORIZED=0

node scripts/simulate-app-login.js ^
  --url            https://sofia-chat-dev.di.telecomitalia.it/a ^
  --browser-url    https://sofia-chat-dev.di.telecomitalia.it/a ^
  --app-name       ai_portal ^
  --user-id        ai_portal ^
  --password       <password> ^
  --caller-user-id mario.rossi ^
  --caller-profile "{\"role\":\"agent\",\"tenant\":\"acme\"}"
```

### dall'esterno per simulazioni con applicazioni esterne

node scripts/simulate-app-login.js --url https://sofia-chat-dev.tisparkle.com/a --browser-url    https://sofia-chat-dev.tisparkle.com/a --app-name ai_portal --user-id ai_portal --password 100969 --caller-user-id antonio.furone --caller-profile "{\"role\":\"agent\",\"tenant\":\"acme\"}"

> **Why two URLs?**  
> In local dev Express (`:3000`) handles API calls but does **not** serve the SPA — that runs on Vite (`:5173`).  
> `--url` is the target for the server-to-server `POST /api/auth/app-login`; `--browser-url` is where the token URL is opened.  
> In production (container) both point to the same host.  
> When behind a **path-based LB** (e.g. `/a`), both `--url` and `--browser-url` must include the sub-path (`https://host/a`). The script appends `/api/auth/app-login` to `--url`, which the LB routes correctly to the container now that `BASE_PATH=/a` is set.

**Session expiry**: after `SESSION_TIMEOUT_MINUTES` of inactivity the session is invalidated.  
- `app` mode → overlay "Session Expired" with reload button.  
- `user` mode → login form is shown again.

### 3 — Managing users

The `sf_user` table holds credentials for both human users (`type = 'user'`) and app-to-app clients (`type = 'app'`).

#### Generate a password hash

`bcryptjs` is already installed. Run the helper script to hash a plaintext password:

```bash
node scripts/hash-password.js mysecretpassword
# → $2a$10$...  (copy this value into pwd_hash)
```

#### Insert a human user (`VITE_AUTH_MODE=user`)

```sql
INSERT INTO sf_user (user_id, type, pwd_hash, active)
VALUES (
  'alice',
  'user',
  '$2a$10$...',   -- output of hash-password.js
  true
);
```

#### Insert an app account (`VITE_AUTH_MODE=app`)

`app_name` identifies the application; `user_id` is the service-account credential used for authentication.

```sql
INSERT INTO sf_user (user_id, app_name, type, pwd_hash, active)
VALUES (
  'crm-svc',   -- service-account credential (used only for authentication)
  'crm',       -- application name (shown in header, passed to agents)
  'app',
  '$2a$10$...',
  true
);
```

Then run the migration to add the new columns to `sf_app_tokens`:
```bash
psql -d <your_db> -f server/migrations/002_add_caller_to_app_tokens.sql
```

The `active` column can be set to `false` to disable a user/app without deleting the row.

---

### 4 — Access control

`sf_agents_access` controls which users/apps can access which agents.

#### User mode — grant a user access to an agent
The `user_id` matches the login `user_id`. The `profile` is injected as metadata.

```sql
INSERT INTO sf_agents_access (agent_name, user_id, profile)
VALUES ('my-agent', 'alice', '{"role": "admin"}');
```

Metadata injected for user mode:
```json
{ "metadata": { "user_id": "alice", "profile": { "role": "admin" } } }
```

#### App mode — grant a caller user access to an agent
The `user_id` here is the **`caller_user_id`** supplied by the calling app at login time.  
The profile in `sf_agents_access` is ignored in app mode — the `caller_profile` supplied at login time is used instead.

```sql
INSERT INTO sf_agents_access (agent_name, user_id)
VALUES ('my-agent', 'mario.rossi');   -- caller_user_id, not the sf_user credential
```

Metadata injected for app mode:
```json
{ "metadata": { "user_id": "mario.rossi", "app_name": "crm", "profile": { "role": "agent" } } }
```

### 5 — Running locally in production mode

```bash
# Terminal 1 — Express backend (hot-reload)
npm run dev:server

# Terminal 2 — Vite frontend (proxies /api/* → Express on :3000)
npm run dev
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite frontend dev server (port 5173) |
| `npm run dev:server` | Express backend with hot-reload (port 3000) |
| `npm run build` | Build React frontend → `dist/` |
| `npm run server:build` | Compile Express TypeScript → `server/dist/` |
| `npm run build:all` | Both of the above (used in Docker) |
| `npm run start` | Start Express in production (`node server/dist/index.js`) |
| `npm run preview` | Preview the production build at port 4173 |

---

## Project structure

```
sofia-client/
├── src/                        # React frontend
│   ├── api/
│   │   ├── client.ts           # Debug A2A client (direct to agent)
│   │   ├── prodClient.ts       # Production A2A client (via Express proxy)
│   │   ├── clientUtils.ts      # Shared JSON-RPC / normalisation helpers
│   │   └── apiBase.ts          # Runtime base path prefix (from VITE_BASE)
│   ├── components/
│   │   ├── parts/              # TextPartView (markdown), FilePartView, DataPartView
│   │   ├── AgentCard.tsx       # Agent details panel
│   │   ├── AgentSelector.tsx   # Production agent dropdown
│   │   ├── LoginForm.tsx       # User auth login form
│   │   └── ...
│   ├── hooks/
│   │   ├── useAgent.ts         # Debug: connect by URL
│   │   ├── useChat.ts          # Debug: send/stream messages
│   │   ├── useChatProd.ts      # Production: send/stream via backend proxy
│   │   └── useAuth.ts          # Production: session management
│   ├── AppDebug.tsx            # Debug UI
│   ├── AppProd.tsx             # Production UI
│   └── App.tsx                 # Mode switcher (VITE_MODE)
│
├── server/                     # Express backend (production mode)
│   ├── src/
│   │   ├── config.ts           # Env vars + validation
│   │   ├── db.ts               # PostgreSQL pool (pg)
│   │   ├── middleware/
│   │   │   ├── session.ts      # express-session + connect-pg-simple
│   │   │   └── requireAuth.ts  # Auth guard + inactivity check
│   │   └── routes/
│   │       ├── auth.ts         # /api/auth/*
│   │       ├── agents.ts       # /api/agents
│   │       └── proxy.ts        # /api/proxy/* (metadata injection + SSE relay)
│   ├── migrations/
│   │   └── 001_init.sql        # DB schema
│   └── tsconfig.json
│
├── Dockerfile                  # Multi-stage build for Cloud Run
├── .dockerignore
├── .env.example
├── package.json                # Unified — frontend + backend deps
├── tsconfig.json               # Frontend TypeScript config
└── vite.config.ts              # Vite config + A2A dev proxy
```

---

## Docker / Cloud Run

### Build the image

```bash
docker build \
  --build-arg VITE_MODE=production \
  --build-arg VITE_AUTH_MODE=user \
  -t sofia-client .
```

### Run locally

```bash
docker run -p 8080:8080 \
  -e SESSION_SECRET=<random-string> \
  -e DB_HOST=<host> \
  -e DB_NAME=<dbname> \
  -e DB_USER=<user> \
  -e DB_PASSWORD=<password> \
  sofia-client
```

### Deploy to Cloud Run

```bash
# Build and push to Artifact Registry
docker build \
  --build-arg VITE_MODE=production \
  --build-arg VITE_AUTH_MODE=user \
  -t europe-docker.pkg.dev/<project>/<repo>/sofia-client:latest .

# sofia-client
# test
docker build --build-arg VITE_MODE=production --build-arg VITE_AUTH_MODE=user -t europe-west8-docker.pkg.dev/spk-dev-dt-prc-0/sofia/sofia-client:latest .
# produzione
docker build --build-arg VITE_MODE=production --build-arg VITE_AUTH_MODE=user -t europe-west8-docker.pkg.dev/spk-pro-dt-prc-0/sofia/sofia-client:latest .

# sofia-client-a  (served at /a behind the internal LB)
# test
docker build --build-arg VITE_MODE=production --build-arg VITE_AUTH_MODE=app --build-arg VITE_BASE=/a/ -t europe-west8-docker.pkg.dev/spk-dev-dt-prc-0/sofia/sofia-client-a:latest .
# produzione
docker build --build-arg VITE_MODE=production --build-arg VITE_AUTH_MODE=app --build-arg VITE_BASE=/a/ -t europe-west8-docker.pkg.dev/spk-pro-dt-prc-0/sofia/sofia-client-a:latest .


gcloud auth login 

gcloud auth configure-docker europe-west8-docker.pkg.dev


# dev
docker push europe-west8-docker.pkg.dev/spk-dev-dt-prc-0/sofia/sofia-client:latest
docker push europe-west8-docker.pkg.dev/spk-dev-dt-prc-0/sofia/sofia-client-a:latest
# produzione
docker push europe-west8-docker.pkg.dev/spk-pro-dt-prc-0/sofia/sofia-client:latest
docker push europe-west8-docker.pkg.dev/spk-pro-dt-prc-0/sofia/sofia-client-a:latest


# Deploy — sofia-client (served at domain root, no BASE_PATH needed)
gcloud run deploy sofia-client \
  --image europe-docker.pkg.dev/<project>/<repo>/sofia-client:latest \
  --region europe-west8 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "SESSION_SECRET=<secret>,DB_HOST=<host>,DB_NAME=<db>,DB_USER=<user>,DB_PASSWORD=<pw>"

# Deploy — sofia-client-a (served at /a behind the internal LB)
gcloud run deploy sofia-client-a \
  --image europe-west8-docker.pkg.dev/<project>/<repo>/sofia-client-a:latest \
  --region europe-west8 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "SESSION_SECRET=<secret>,DB_HOST=<host>,DB_NAME=<db>,DB_USER=<user>,DB_PASSWORD=<pw>,BASE_PATH=/a"
```

> **Cloud Run request timeout**: `--timeout` is intentionally **not** passed here — Cloud Run keeps whatever value
> the service already has when the flag is omitted (it only applies its own default the *first* time a service is
> created). Checked on 2026-07-02: `sofia-client` = 800 s, `sofia-client-a` = 300 s. Both were ruled out as the
> cause of the "stream stops after ~2 minutes" issue — the actual cutoff traced back to the *agent's* own server
> (see the SSE section below), not to either of these services. Don't add `--timeout` to the commands above
> without first checking the live value — passing a lower number than what's currently set would silently reduce
> it. To check: `gcloud run services describe <service> --region europe-west8 --format="value(spec.template.spec.timeoutSeconds)"`.

> **Note**: `VITE_MODE`, `VITE_AUTH_MODE` and `VITE_BASE` are **build-time** arguments baked into the image.  
> All other variables (`BASE_PATH`, `SESSION_SECRET`, `DB_*`) are runtime env vars set in Cloud Run — never put them in the image.  
> For `sofia-client-a`, always pass `BASE_PATH=/a` as a runtime env var to match the LB path prefix.

---

## Timeout reference

All timeouts in the application, grouped by layer.

### Session & authentication

| Timeout | Default | Where to change |
|---------|---------|-----------------|
| **Session inactivity** — server destroys the session after this period of inactivity | 30 min | `SESSION_TIMEOUT_MINUTES` env var (runtime) |
| **App one-time token expiry** — the token issued by `POST /api/auth/app-login` expires after this time | 5 min | Hardcoded in `server/src/routes/auth.ts` (`Date.now() + 5 * 60 * 1000`) |

### Agent connection (frontend — production mode)

These govern the startup overlay shown when selecting an agent that may be cold-starting.

| Timeout | Default | Where to change |
|---------|---------|-----------------|
| **Cold-start max wait** — total time the UI waits for the agent to respond before showing "Connection failed" | 60 s | `CONNECT_TIMEOUT_MS` constant at the top of `src/AppProd.tsx` |
| **Retry interval** — how often a new connection attempt is made while waiting | 5 s | `CONNECT_RETRY_MS` constant at the top of `src/AppProd.tsx` |

### Streaming (frontend — production mode)

| Timeout | Default | Where to change |
|---------|---------|-----------------|
| **SSE inactivity watchdog** — aborts the stream if no SSE chunk is yielded to the UI within this window; surfaces as "Request cancelled: agent did not respond in time". Resets only on chunks that carry visible parts or a final status, **not** on silent keep-alive status events. | 180 s | `CLIENT_STREAM_TIMEOUT_MS` constant at the top of `src/hooks/useChatProd.ts` |

### Agent calls (frontend — debug mode)

In debug mode the browser calls the agent directly (via the Vite dev proxy) without an Express backend. Both timeouts apply to the native `fetch` call.

| Timeout | Default | Where to change |
|---------|---------|-----------------|
| **Non-streaming request timeout** — max time for a `message/send` round-trip | 180 s | `AbortSignal.timeout(180_000)` in `sendChat` in `src/api/client.ts` |
| **SSE request timeout** — max total time for the entire `message/stream` SSE connection | 180 s | `AbortSignal.timeout(180_000)` in `streamChat` in `src/api/client.ts` |

### Backend proxy (server — production mode)

| Timeout | Default | Where to change |
|---------|---------|-----------------|
| **Non-streaming request timeout** — max time allowed for a `message/send` round-trip | 180 s | `AbortSignal.timeout(180_000)` in `server/src/routes/proxy.ts` (send handler) |
| **SSE first-byte timeout** — max time to receive the first byte from the agent on a streaming request; aborts with 502 if exceeded | 180 s | `CONNECT_TIMEOUT_MS` constant in `server/src/routes/proxy.ts` (stream handler) |
| **SSE no-data watchdog** — if the stream goes silent for this long after the first byte, the connection is aborted and an error event is written to the client | 180 s | `NO_DATA_TIMEOUT_MS` constant in `server/src/routes/proxy.ts` (stream handler) |
| **Agent card fetch timeout** — per-attempt timeout when resolving the RPC URL from `/.well-known/agent.json` | 5 s | `AbortSignal.timeout(5000)` in `server/src/routes/proxy.ts` (`resolveRpcUrl`) |
| **RPC URL cache TTL** — how long the resolved agent RPC endpoint is cached before re-reading the agent card | 5 min | `RPC_CACHE_TTL_MS` constant at the top of `server/src/routes/proxy.ts` |

### Database pool (server)

| Timeout | Default | Where to change |
|---------|---------|-----------------|
| **Connection acquire timeout** — max time to obtain a connection from the pool | 5 s | `connectionTimeoutMillis` in `server/src/db.ts` |
| **Idle connection timeout** — how long an unused pooled connection is kept open before being closed | 30 s | `idleTimeoutMillis` in `server/src/db.ts` |

### UI

| Timeout | Default | Where to change |
|---------|---------|-----------------|
| **Error toast auto-dismiss** — how long the error banner stays visible before fading out | 6 s | `autoDismissMs` default prop in `src/components/ErrorToast.tsx` |

### Infrastructure (Dockerfile)

| Parameter | Value | Effect |
|-----------|-------|--------|
| `--interval` | 30 s | How often Cloud Run polls the health endpoint (`${BASE_PATH}/api/health`) |
| `--timeout` | 5 s | Max time a single health check probe may take |
| `--start-period` | 10 s | Grace period before the first health check fires |

### Infrastructure (Cloud Run service — outside this repo)

| Timeout | Live value (checked 2026-07-02) | Where to change |
|---------|----------------------------------|-----------------|
| **Request timeout** — Cloud Run kills the whole request (including an in-progress SSE stream) after this long, no matter what the app-level timeouts above say | `sofia-client` = 800 s, `sofia-client-a` = 300 s | `--timeout` flag on `gcloud run deploy` — not currently passed, so it's whatever was last configured (see note above the deploy commands) |

Both values comfortably exceed the 180 s app-level SSE watchdogs, so this was **ruled out** as the cause of streams stopping after ~2 minutes even though it was the first suspect — the actual cutoff was inside the *agent's own* server (it blocks synchronously on a non-streaming sub-agent call for longer than its own worker/process timeout allows, killing the SSE connection back to sofia-client), not a Cloud Run setting on either sofia-client service.
| `--failure-threshold` | 12 | Number of consecutive failures before the container is considered unhealthy — combined with the above, the container has up to **10 + 12 × 10 = 130 s** to become healthy |

Change these in the `HEALTHCHECK` directive in `Dockerfile`.

---

## UI features

- **Markdown + HTML rendering** — agent responses are rendered with full markdown support (headings, tables, code blocks, lists, blockquotes)
- **Resizable response bubbles** — drag the bottom-right handle to widen agent messages (useful for wide tables)
- **Agent chip in header** — when connected, shows agent name and version; click to toggle the detail panel
- **Streaming** — SSE streaming with live cursor indicator; toggle per session
- **Debug drawer** — per-message collapsible panel showing raw A2A request/response JSON
- **Tool calls** — `DataPart` items shown in a collapsible "tool calls" drawer
