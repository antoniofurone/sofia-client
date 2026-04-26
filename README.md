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
| `PORT` | `3000` | Express server port. |
| `SESSION_SECRET` | random string | Required when `VITE_AUTH_MODE` ≠ `none`. |
| `SESSION_TIMEOUT_MINUTES` | `30` | Inactivity session timeout. |
| `DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD` | — | PostgreSQL connection (production only). |

> `VITE_*` variables are **build-time** — they are compiled into the JavaScript bundle by Vite. Runtime variables (`DB_*`, `SESSION_SECRET`, `PORT`) are read by the Express server at startup.

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
```

> **Why two URLs?**  
> In local dev Express (`:3000`) handles API calls but does **not** serve the SPA — that runs on Vite (`:5173`).  
> `--url` is the target for the server-to-server `POST /api/auth/app-login`; `--browser-url` is where the token URL is opened.  
> In production (container) both point to the same host.

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
│   │   └── clientUtils.ts      # Shared JSON-RPC / normalisation helpers
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

docker push europe-docker.pkg.dev/<project>/<repo>/sofia-client:latest

# Deploy
gcloud run deploy sofia-client \
  --image europe-docker.pkg.dev/<project>/<repo>/sofia-client:latest \
  --region europe-west1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "SESSION_SECRET=<secret>,DB_HOST=<host>,DB_NAME=<db>,DB_USER=<user>,DB_PASSWORD=<pw>"
```

> **Note**: `VITE_MODE` and `VITE_AUTH_MODE` are **build-time** arguments baked into the image.  
> All other sensitive variables are runtime env vars set in Cloud Run — never put them in the image.

---

## UI features

- **Markdown + HTML rendering** — agent responses are rendered with full markdown support (headings, tables, code blocks, lists, blockquotes)
- **Resizable response bubbles** — drag the bottom-right handle to widen agent messages (useful for wide tables)
- **Agent chip in header** — when connected, shows agent name and version; click to toggle the detail panel
- **Streaming** — SSE streaming with live cursor indicator; toggle per session
- **Debug drawer** — per-message collapsible panel showing raw A2A request/response JSON
- **Tool calls** — `DataPart` items shown in a collapsible "tool calls" drawer
