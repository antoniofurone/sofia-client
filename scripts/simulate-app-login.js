#!/usr/bin/env node
/**
 * Simulate an app-to-app login against a running Sofia Client instance.
 *
 * The script replicates what an external application would do:
 *   1. POST /api/auth/app-login  (server-to-server)  → one-time token
 *   2. Open the browser at /?app_token=<token>        → session cookie
 *
 * Credentials used for authentication (must exist in sf_user with type='app'):
 *   --app-name      app_name in sf_user
 *   --user-id       user_id in sf_user
 *   --password      plaintext password  (or SOFIA_APP_PASSWORD env var)
 *
 * Caller identity (end-user of the calling app — displayed in Sofia's header and
 * injected into every agent message as metadata):
 *   --caller-user-id    the end-user's ID in the calling app  (required)
 *   --caller-profile    JSON profile for that user            (optional)
 *
 * Other options:
 *   --url           Base URL for API calls (Express)   (default: http://localhost:3000)
 *   --browser-url   Base URL opened in the browser     (default: same as --url)
 *                   In local dev use http://localhost:5173 (Vite) while --url stays :3000.
 *   --no-open       Print the URL but do NOT open the browser
 *
 * Examples:
 *   # Minimal — local dev
 *   node scripts/simulate-app-login.js ^
 *     --password secret ^
 *     --caller-user-id mario.rossi ^
 *     --browser-url http://localhost:5173
 *
 *   # Full options (Windows cmd)
 *   node scripts/simulate-app-login.js ^
 *     --url           http://localhost:3000 ^
 *     --browser-url   http://localhost:5173 ^
 *     --app-name      crm ^
 *     --user-id       crm-svc ^
 *     --password      s3cr3t ^
 *     --caller-user-id mario.rossi ^
 *     --caller-profile "{\"role\":\"agent\",\"tenant\":\"acme\"}"
 *
 *   # Password via env var (avoids it appearing in shell history)
 *   set SOFIA_APP_PASSWORD=secret
 *   node scripts/simulate-app-login.js --caller-user-id mario.rossi --browser-url http://localhost:5173
 */

const { execSync } = require('child_process');
const https = require('https');
const http  = require('http');

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function argValue(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function parseJson(raw, flagName) {
  if (!raw) return null;
  // On Windows, single quotes are not stripped by the shell — remove them if present.
  const cleaned = raw.replace(/^'+|'+$/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error(`ERROR: ${flagName} must be valid JSON.`);
    console.error(`  Windows cmd :  ${flagName} "{\\"role\\":\\"admin\\"}"`);
    console.error(`  Windows PS  :  ${flagName} '{"role":"admin"}'`);
    console.error(`  bash/zsh    :  ${flagName} '{"role":"admin"}'`);
    process.exit(1);
  }
}

const BASE_URL        = argValue('--url')              ?? 'http://localhost:3000';
const BROWSER_URL     = argValue('--browser-url')      ?? BASE_URL;
const APP_NAME        = argValue('--app-name')         ?? 'my-app';
const USER_ID         = argValue('--user-id')          ?? 'app-user';
const PASSWORD        = argValue('--password')         ?? process.env.SOFIA_APP_PASSWORD;
const CALLER_USER_ID  = argValue('--caller-user-id');
const NO_OPEN         = args.includes('--no-open');

const callerProfile = parseJson(argValue('--caller-profile'), '--caller-profile');

if (!PASSWORD) {
  console.error('ERROR: --password is required (or set SOFIA_APP_PASSWORD env var).');
  process.exit(1);
}

if (!CALLER_USER_ID) {
  console.error('ERROR: --caller-user-id is required.');
  console.error('  This is the end-user ID of the calling app (e.g. mario.rossi).');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore' });
    } else if (platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const base        = BASE_URL.replace(/\/+$/, '');
  const browserBase = BROWSER_URL.replace(/\/+$/, '');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Sofia Client — simulate app-to-app login');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  API URL          : ${base}`);
  console.log(`  Browser URL      : ${browserBase}`);
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  App credentials (sf_user):');
  console.log(`    app_name       : ${APP_NAME}`);
  console.log(`    user_id        : ${USER_ID}`);
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  Caller identity (passed to agents as metadata):');
  console.log(`    caller_user_id : ${CALLER_USER_ID}`);
  console.log(`    caller_profile : ${JSON.stringify(callerProfile ?? {})}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // ── Step 1: obtain a one-time token ────────────────────────────────────────
  console.log('▶ Step 1 — POST /api/auth/app-login ...');

  let token;
  try {
    const { status, body } = await postJson(`${base}/api/auth/app-login`, {
      app_name:        APP_NAME,
      user_id:         USER_ID,
      password:        PASSWORD,
      caller_user_id:  CALLER_USER_ID,
      caller_profile:  callerProfile ?? undefined,
    });

    if (status !== 200 || !body.token) {
      console.error(`  ERROR ${status}: ${JSON.stringify(body)}`);
      console.error('');
      console.error('  Possible causes:');
      console.error('    • VITE_AUTH_MODE is not "app"');
      console.error('    • app_name / user_id / password are wrong');
      console.error('    • The sf_user row has active=FALSE or type≠"app"');
      process.exit(1);
    }

    token = body.token;
    console.log(`  ✓ Token received: ${token.slice(0, 12)}…`);
  } catch (err) {
    console.error(`  ERROR: Could not reach ${base}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  // ── Step 2: open browser ───────────────────────────────────────────────────
  const browserUrl = `${browserBase}/?app_token=${token}`;

  console.log('');
  console.log('▶ Step 2 — Open browser:');
  console.log(`  ${browserUrl}`);
  console.log('');

  if (NO_OPEN) {
    console.log('  (--no-open: copy the URL above and paste it in your browser)');
  } else {
    const opened = openBrowser(browserUrl);
    if (opened) {
      console.log('  ✓ Browser opened');
    } else {
      console.log('  ⚠ Could not open the browser automatically.');
      console.log('    Copy the URL above and paste it manually.');
    }
  }

  console.log('');
  console.log('  Note: the token is single-use and expires in 5 minutes.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
})();
