# Sofia Client

A React/TypeScript chat client for agents that implement the [A2A protocol](https://google.github.io/A2A/).

Supports all A2A part types (text, file, data), streaming via SSE, API key authentication, and a built-in debug drawer per message.

---

## Requirements

- Node.js ≥ 18
- npm ≥ 9 **or** pnpm ≥ 8

---

## Installation

```bash
# npm
npm install

# pnpm
pnpm install
```

---

## Development

Starts the Vite dev server on `http://localhost:5173`.  
A built-in proxy forwards `/a2a-proxy` requests to the target agent, avoiding CORS issues in the browser.

```bash
# npm
npm run dev

# pnpm
pnpm dev
```

---

## Production build

Compiles TypeScript and bundles the app into `dist/`.

```bash
# npm
npm run build

# pnpm
pnpm build
```

In production the browser calls the agent URL directly — make sure the agent exposes the appropriate CORS headers (`Access-Control-Allow-Origin`).

### Preview the production build locally

```bash
# npm
npm run preview

# pnpm
pnpm preview
```

This serves the `dist/` folder on `http://localhost:4173`.

---

## Connecting to an agent

1. Enter the agent's base URL (e.g. `https://my-agent.example.com`).
2. Optionally enter an API key — it will be sent as `X-API-Key: <key>` on every request.
3. Click **Connect**. The client fetches the agent card from `/.well-known/agent.json` and is ready to chat.

---

## Project structure

```
src/
  api/          # A2A HTTP client (sendChat / streamChat)
  components/   # React UI components
    parts/      # Renderers for TextPart, FilePart, DataPart
  hooks/        # useAgent, useChat
  types/        # A2A TypeScript types
```
