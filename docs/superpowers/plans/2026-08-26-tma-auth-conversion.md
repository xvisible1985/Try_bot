# Telegram Mini App Auth Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tg-web's Telegram Login Widget auth with Telegram Mini App `initData` auth (invisible, automatic login on open), and add a persistent menu button in tg-bot that launches tg-web as a Mini App.

**Architecture:** A new HMAC verifier (`lib/telegramWebApp.js`, a different signing algorithm from the Login Widget's) backs a new `POST /tma/auth` route that sets the exact same `req.session.userId` the old flow used to — every downstream consumer (`requireAuth`, `requireAdmin`, avatar upload, admin panel) is untouched. The old Login Widget code is removed once the new flow is proven working. tg-bot gets one new env var and one `bot.setChatMenuButton(...)` call.

**Tech Stack:** Node.js, Express, `crypto` (built-in), `node-telegram-bot-api` 0.66.0.

---

## Spec

Full design: `docs/superpowers/specs/2026-08-26-tma-auth-conversion-design.md`. Read it before starting.

## Critical shared context — read this before any task

**Two repos, two conventions.** `tg-web` (c:\Users\123\Projects\tg-web) commits straight to its own `main`, **no remote configured, do not push**. `tg-bot` (c:\Users\123\Projects\tg-bot) commits straight to `main` and **pushes immediately** after every commit, per this whole session's standing convention for that repo specifically.

**Re-locate every anchor by searching for the quoted surrounding text, never trust a stated line number** — both files this plan touches (`tg-web/index.js`, `tg-bot/bot.js`) have accumulated a lot of history.

**The one detail most likely to be implemented wrong:** the Mini App signature check's secret key is `HMAC_SHA256(key: "WebAppData", message: bot_token)` — an HMAC, not `crypto.createHash('sha256').update(botToken)` like the old Login Widget verifier (`lib/telegramAuth.js`) uses. Copying that file's pattern here would silently produce a verifier that rejects every real login. Task 1's own isolated verification script is the safety net for this — it hand-signs a payload using the exact same algorithm the implementation uses, so if both sides of the test use the wrong algorithm consistently, the test would still pass; the real check is that the code in Task 1's Step 1 uses `crypto.createHmac('sha256', 'WebAppData')`, not `crypto.createHash('sha256')` — verify this by reading the actual line, not by trusting the test result alone.

No troll-bot changes anywhere in this plan.

---

### Task 1: `lib/telegramWebApp.js` — the Mini App `initData` verifier

**Files:**
- Create: `c:\Users\123\Projects\tg-web\lib\telegramWebApp.js`

- [ ] **Step 1: Write `lib/telegramWebApp.js`**

```js
const crypto = require('crypto');

// Telegram Mini App initData check: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Structurally similar to the Login Widget's check (lib/telegramAuth.js,
// removed later in this plan) but NOT the same algorithm — do not
// "simplify" this back to that file's pattern:
// 1. Drop `hash`, sort remaining fields alphabetically, join "key=value"
//    lines with "\n" — same data-check-string idea as the Login Widget.
// 2. secret_key = HMAC-SHA256(key: the literal string "WebAppData",
//    message: bot_token) — an HMAC, not a plain SHA256 hash of the
//    token. This is the one detail most likely to get copy-pasted wrong
//    from the Login Widget's `crypto.createHash('sha256').update(...)`.
// 3. computed_hash = HMAC-SHA256(secret_key, data-check-string), hex.
// 4. Reject unless computed_hash === received hash (constant-time) AND
//    auth_date is recent — 1 hour here, tighter than the Login Widget's
//    24h, since Telegram regenerates initData fresh every time the Mini
//    App is opened; there's no reason for a legitimate one to be old.
// 5. On success, the `user` field is itself a JSON string — parse it and
//    return its numeric `id`. Never throws: every failure path (bad
//    signature, stale date, missing/malformed `user`) returns null so
//    callers can use it directly without a try/catch.
const MAX_AUTH_AGE_SECONDS = 60 * 60;

function verifyWebAppInitData(initData, botToken) {
  if (typeof initData !== 'string' || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const fields = [];
  for (const key of Array.from(params.keys()).sort()) {
    fields.push(`${key}=${params.get(key)}`);
  }
  const checkString = fields.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  const receivedBuffer = Buffer.from(hash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');
  if (receivedBuffer.length !== computedBuffer.length) return null;
  if (!crypto.timingSafeEqual(receivedBuffer, computedBuffer)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS || ageSeconds < -60) return null;

  try {
    const user = JSON.parse(params.get('user'));
    if (!user || !Number.isFinite(Number(user.id))) return null;
    return Number(user.id);
  } catch {
    return null;
  }
}

module.exports = { verifyWebAppInitData };
```

- [ ] **Step 2: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-web && node --check lib/telegramWebApp.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Write and run the isolated verification script**

This is the second piece of real cryptography in this project (the first was the Login Widget's HMAC) — hand-construct a valid `initData` string using the exact algorithm the function itself is supposed to use, then verify every rejection path too.

Create `c:\Users\123\Projects\tg-web\_verify_tma_auth.js`:

```js
const crypto = require('crypto');
const { verifyWebAppInitData } = require('./lib/telegramWebApp');

const botToken = 'TEST:TOKEN_FOR_VERIFICATION_ONLY';

function signInitData(fields, token) {
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  return crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
}

function buildInitData(fields, token) {
  const hash = signInitData(fields, token);
  return new URLSearchParams({ ...fields, hash }).toString();
}

const now = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 12345, first_name: 'Test', username: 'testuser' });
const validFields = { query_id: 'AAH1234', user, auth_date: String(now) };
const validInitData = buildInitData(validFields, botToken);

console.log('valid initData accepted, returns numeric id:', verifyWebAppInitData(validInitData, botToken), 'expected 12345');

const validHash = signInitData(validFields, botToken);
const tamperedInitData = new URLSearchParams({ ...validFields, user: JSON.stringify({ id: 99999, first_name: 'Evil' }), hash: validHash }).toString();
console.log('tampered user field rejected:', verifyWebAppInitData(tamperedInitData, botToken), 'expected null');

const garbageHashInitData = new URLSearchParams({ ...validFields, hash: 'deadbeef' }).toString();
console.log('garbage hash rejected:', verifyWebAppInitData(garbageHashInitData, botToken), 'expected null');

const staleFields = { ...validFields, auth_date: String(now - 2 * 60 * 60) };
const staleInitData = buildInitData(staleFields, botToken);
console.log('stale auth_date (2h old) rejected:', verifyWebAppInitData(staleInitData, botToken), 'expected null');

const noHashInitData = new URLSearchParams(validFields).toString();
console.log('missing hash rejected:', verifyWebAppInitData(noHashInitData, botToken), 'expected null');

const malformedUserFields = { query_id: 'AAH1234', user: 'not-json', auth_date: String(now) };
const malformedUserInitData = buildInitData(malformedUserFields, botToken);
console.log('valid sig but malformed user field returns null, no throw:', verifyWebAppInitData(malformedUserInitData, botToken), 'expected null');

console.log('wrong bot token rejected:', verifyWebAppInitData(validInitData, 'WRONG:TOKEN'), 'expected null');
```

Run: `cd c:\Users\123\Projects\tg-web && node _verify_tma_auth.js`

Expected output (must match exactly):
```
valid initData accepted, returns numeric id: 12345 expected 12345
tampered user field rejected: null expected null
garbage hash rejected: null expected null
stale auth_date (2h old) rejected: null expected null
missing hash rejected: null expected null
valid sig but malformed user field returns null, no throw: null expected null
wrong bot token rejected: null expected null
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-web\_verify_tma_auth.js`

- [ ] **Step 4: Commit**

```bash
cd c:\Users\123\Projects\tg-web
git add lib/telegramWebApp.js
git commit -m "feat: Telegram Mini App initData verification"
```

No `git push` — this repo has no remote configured.

---

### Task 2: `POST /tma/auth` route + `views/layout.js` bootstrap script

**Files:**
- Modify: `c:\Users\123\Projects\tg-web\index.js`
- Modify: `c:\Users\123\Projects\tg-web\views\layout.js`

**Depends on Task 1.** This task ADDS the new auth flow alongside the old one — the old Login Widget code is removed in Task 3, not here, so a mistake in the new flow doesn't get compounded with simultaneously ripping out the old one.

- [ ] **Step 1: Add the new route**

Find (search `const { verifyTelegramLogin } = require('./lib/telegramAuth');`):

```js
const { verifyTelegramLogin } = require('./lib/telegramAuth');
const renderLogin = require('./views/login');
```

Replace with:

```js
const { verifyTelegramLogin } = require('./lib/telegramAuth');
const renderLogin = require('./views/login');
const { verifyWebAppInitData } = require('./lib/telegramWebApp');
```

Find (search `app.get('/logout', (req, res) => {`, this whole block through the blank line after it):

```js
app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.get('/', (req, res) => {
```

Replace with:

```js
app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.post('/tma/auth', express.json(), (req, res) => {
  const userId = verifyWebAppInitData(req.body.initData, process.env.TG_BOT_TOKEN);
  if (!userId) return res.status(403).json({ ok: false });
  req.session.userId = userId;
  res.json({ ok: true });
});

app.get('/', (req, res) => {
```

(`express.json()` is scoped to just this one route, not applied globally — the existing upload routes use `multipart/form-data` via `multer`, and there's no reason to have a JSON body-parser active on requests it'll never need to touch.)

- [ ] **Step 2: Add the Mini App bootstrap script to the shared layout**

Find (search `<body>\n${bodyHtml}\n</body>` in `views/layout.js` — i.e. the literal end of the template):

```js
<body>
${bodyHtml}
</body>
</html>`;
```

Replace with:

```js
<body>
${bodyHtml}
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
  (function () {
    if (!window.Telegram || !window.Telegram.WebApp || !window.Telegram.WebApp.initData) return;
    if (document.cookie.indexOf('session=') !== -1) return;
    fetch('/tma/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: window.Telegram.WebApp.initData }),
    }).then(function (r) { if (r.ok) location.reload(); });
  })();
</script>
</body>
</html>`;
```

This runs on every page (the shared shell). No Telegram context → silent no-op (the page just renders logged-out, same as today). Session cookie already present (valid 30 days) → skipped, no repeated round-trip on every navigation. Otherwise: one fire-and-forget POST, one reload, then never again until the cookie expires.

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-web && node --check index.js && node --check views/layout.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual smoke test of the new route (hand-signed initData, no real Telegram client needed yet)**

Create `c:\Users\123\Projects\tg-web\_verify_tma_route.js`:

```js
const crypto = require('crypto');

process.env.SESSION_SECRET = 'test-secret';
process.env.TG_BOT_TOKEN = 'test:token';
process.env.GAME_DB_PATH = process.env.GAME_DB_PATH || 'C:/Users/123/Projects/tg-bot/mutes.db';
process.env.TG_BOT_USERNAME = 'test_bot';
process.env.PORT = 5980;
require('./index.js');

function signInitData(fields, token) {
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  return crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
}

const now = Math.floor(Date.now() / 1000);
const fields = { query_id: 'AAH1', user: JSON.stringify({ id: 555, first_name: 'Smoke' }), auth_date: String(now) };
const hash = signInitData(fields, 'test:token');
const initData = new URLSearchParams({ ...fields, hash }).toString();
console.log(initData);
```

Run: `cd c:\Users\123\Projects\tg-web && node _verify_tma_route.js > _tma_initdata.txt 2>&1 &`, wait a moment, then:

```bash
cd c:\Users\123\Projects\tg-web
INIT_DATA=$(tail -1 _tma_initdata.txt)
curl -s -D - -o /dev/null -X POST http://localhost:5980/tma/auth -H "Content-Type: application/json" -d "{\"initData\": \"$(node -e "console.log(JSON.stringify(process.argv[1]).slice(1,-1))" "$INIT_DATA")\"}"
```

Expected: `HTTP/1.1 200` and a `Set-Cookie: session=...` header. Then test rejection with a bad payload:

```bash
curl -s -D - -o /dev/null -X POST http://localhost:5980/tma/auth -H "Content-Type: application/json" -d '{"initData": "garbage"}'
```

Expected: `HTTP/1.1 403`, no `Set-Cookie` header.

Stop the server (`kill %1` or close the terminal) and delete both scratch files: `rm c:\Users\123\Projects\tg-web\_verify_tma_route.js c:\Users\123\Projects\tg-web\_tma_initdata.txt`

- [ ] **Step 5: Commit**

```bash
cd c:\Users\123\Projects\tg-web
git add index.js views/layout.js
git commit -m "feat: POST /tma/auth + Mini App bootstrap script in the shared layout"
```

No `git push`.

---

### Task 3: Remove the old Telegram Login Widget code

**Files:**
- Delete: `c:\Users\123\Projects\tg-web\views\login.js`
- Delete: `c:\Users\123\Projects\tg-web\lib\telegramAuth.js`
- Modify: `c:\Users\123\Projects\tg-web\index.js`
- Modify: `c:\Users\123\Projects\tg-web\.env.example`
- Modify: `c:\Users\123\Projects\tg-web\lib\requireAuth.js`
- Modify: `c:\Users\123\Projects\tg-web\lib\requireAdmin.js`

**Depends on Task 2** (the new `/tma/auth` flow must already be working before the old one is removed).

- [ ] **Step 1: Delete the two obsolete files**

```bash
cd c:\Users\123\Projects\tg-web
rm views/login.js lib/telegramAuth.js
```

- [ ] **Step 2: Remove the old requires and routes from `index.js`**

Find (search `const { verifyTelegramLogin } = require('./lib/telegramAuth');`):

```js
const { verifyTelegramLogin } = require('./lib/telegramAuth');
const renderLogin = require('./views/login');
const { verifyWebAppInitData } = require('./lib/telegramWebApp');
```

Replace with:

```js
const { verifyWebAppInitData } = require('./lib/telegramWebApp');
```

Find (search `app.get('/login', (req, res) => {`, this whole block through the `app.post('/tma/auth'` line that currently follows it):

```js
app.get('/login', (req, res) => {
  res.send(renderLogin(process.env.TG_BOT_USERNAME));
});

app.get('/login/callback', (req, res) => {
  const ok = verifyTelegramLogin(req.query, process.env.TG_BOT_TOKEN);
  if (!ok) return res.status(403).send('Не удалось подтвердить вход через Telegram.');
  req.session.userId = Number(req.query.id);
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.post('/tma/auth', express.json(), (req, res) => {
```

Replace with:

```js
app.post('/tma/auth', express.json(), (req, res) => {
```

- [ ] **Step 3: Remove the now-unused `TG_BOT_USERNAME` from `.env.example`**

Find:

```
# tg-bot's own bot token, needed to verify Telegram Login Widget signatures
TG_BOT_TOKEN=
# tg-bot's own bot USERNAME (no @), needed to render the login widget
TG_BOT_USERNAME=
# Comma-separated numeric Telegram user_ids allowed into /admin
```

Replace with:

```
# tg-bot's own bot token, needed to verify Telegram Mini App initData signatures
TG_BOT_TOKEN=
# Comma-separated numeric Telegram user_ids allowed into /admin
```

- [ ] **Step 4: Fix `requireAuth`/`requireAdmin`'s now-dead redirect target**

Deleting `/login` in Step 2 leaves `lib/requireAuth.js` and `lib/requireAdmin.js` redirecting to a route that no longer exists — anyone hitting `/me/avatar` or `/admin` without a session (e.g. opening the raw URL outside Telegram, where the bootstrap script has nothing to authenticate with) would get bounced to a 404 instead of a helpful message. Fix both files now, in the same task that causes the breakage, rather than shipping it and hoping someone notices during manual testing.

Find (in `lib/requireAuth.js`):

```js
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}
```

Replace with:

```js
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(403).send('Открой это приложение через кнопку в Telegram-боте.');
  }
  next();
}
```

Find (in `lib/requireAdmin.js`):

```js
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  if (!getAdminUserIds().includes(req.session.userId)) {
    return res.status(403).send('Доступ только для администраторов.');
  }
  next();
}
```

Replace with:

```js
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(403).send('Открой это приложение через кнопку в Telegram-боте.');
  }
  if (!getAdminUserIds().includes(req.session.userId)) {
    return res.status(403).send('Доступ только для администраторов.');
  }
  next();
}
```

- [ ] **Step 5: Syntax-check and confirm no dangling references**

Run: `cd c:\Users\123\Projects\tg-web && node --check index.js && node --check lib/requireAuth.js && node --check lib/requireAdmin.js`
Expected: no output, exit code 0.

Run: `cd c:\Users\123\Projects\tg-web && grep -rn "verifyTelegramLogin\|renderLogin\|telegramAuth\|TG_BOT_USERNAME\|/login" --include=*.js .`
Expected: no output (nothing left referencing the removed code). If `node_modules` shows up in results, ignore matches under that directory — they're unrelated third-party code, not this app's own.

- [ ] **Step 6: Re-run Task 2's smoke test to confirm the new flow still works after the old code is gone**

Repeat Task 2's Step 4 exactly (same script, same curl commands, same expected `200`/`Set-Cookie` and `403`/no-cookie results) — this confirms removing the old code didn't accidentally break the new route (e.g. by deleting a shared piece both used).

- [ ] **Step 7: Commit**

```bash
cd c:\Users\123\Projects\tg-web
git add -A
git commit -m "chore: remove Telegram Login Widget (superseded by Mini App auth)"
```

No `git push`.

---

### Task 4: tg-bot — persistent menu button launching the Mini App

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

**Independent of Tasks 1-3** — can be done in any order relative to them, since it's a separate repo and the menu button just needs a URL, not tg-web's internals.

**Verified before writing this task:** `node-telegram-bot-api` 0.66.0 (the version installed in this repo) does expose `setChatMenuButton(form)`, which POSTs to the Bot API's `setChatMenuButton` method. Its internal `_fixReplyMarkup` helper JSON-stringifies `reply_markup` automatically but does **not** do the same for `menu_button` — so `menu_button` must be JSON-stringified explicitly before being passed in, or Telegram will receive a malformed value.

- [ ] **Step 1: Add the `WEB_APP_URL` env var read**

Find (search `const token = process.env.BOT_TOKEN;`):

```js
const token = process.env.BOT_TOKEN;
const proxy = process.env.PROXY_URL;
```

Replace with:

```js
const token = process.env.BOT_TOKEN;
const proxy = process.env.PROXY_URL;
const webAppUrl = process.env.WEB_APP_URL;
```

- [ ] **Step 2: Set the menu button right after the bot is constructed**

Find (search `const bot = new TelegramBot(token, { polling: { autoStart: false }, request: { agent } });`):

```js
const bot = new TelegramBot(token, { polling: { autoStart: false }, request: { agent } });
```

Replace with:

```js
const bot = new TelegramBot(token, { polling: { autoStart: false }, request: { agent } });

// Persistent menu button next to the message input, opening tg-web as a
// Telegram Mini App — idempotent (safe to call on every boot; Telegram
// just keeps the setting if unchanged). menu_button must be
// JSON-stringified here: node-telegram-bot-api only auto-serializes
// `reply_markup` for form fields (see its _fixReplyMarkup), not
// menu_button, so passing a raw object would silently form-encode wrong.
if (webAppUrl) {
  bot.setChatMenuButton({
    menu_button: JSON.stringify({ type: 'web_app', text: 'Боец', web_app: { url: webAppUrl } }),
  }).catch(err => console.error('setChatMenuButton failed:', err.message));
} else {
  console.error('WEB_APP_URL not set — skipping setChatMenuButton');
}
```

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

**Note on verification limits:** this call's actual effect (does the menu button really appear and open the right URL in a real Telegram client) can only be confirmed against live Telegram infrastructure with a real bot token — there is no meaningful way to unit-test an external Bot API side effect locally. The syntax-check and the code-review pass (confirming the JSON-stringify shape and the correct method name/signature against the installed library, both already done above) are what this task can verify; real confirmation happens in Task 5's manual verification.

- [ ] **Step 4: Commit and push**

```bash
cd c:\Users\123\Projects\tg-bot
git add bot.js
git commit -m "feat: persistent menu button launching tg-web as a Telegram Mini App"
git push
```

(This repo pushes immediately per standing convention — unlike tg-web.)

---

### Task 5: Manual deployment + verification (left to user)

Not automated — requires the real VPS, real bot token, and a real Telegram client.

- [ ] **Re-verify against current Telegram Bot API documentation** whether a Bot-API-set `web_app` menu button requires any `@BotFather` domain/app registration step beyond what the original fighter-web-profile plan's Task 6 already covered. This was explicitly flagged as unverified in the design spec — check Telegram's current docs rather than assuming either answer.
- [ ] On the VPS, in tg-bot's deployed `.env` (`/root/Try_bot/.env`): add `WEB_APP_URL=` pointing at wherever tg-web is publicly reachable (the same domain/URL configured in the original fighter-web-profile plan's Task 6).
- [ ] On the VPS, in tg-web's deployed `.env` (`/root/tg-web/.env`): remove the now-unused `TG_BOT_USERNAME=` line (harmless if left, but nothing reads it anymore).
- [ ] `git pull` both repos on the VPS, then `pm2 restart tg-bot` and `pm2 restart tg-web`.
- [ ] Verify: open the bot in a Telegram client, confirm a menu button appears next to the message input and opens the Mini App. Confirm the leaderboard/profile pages load already logged-in with no visible login step (check `/me/avatar` takes you straight to the upload form). Confirm avatar upload still works. Log in as the admin account specifically and confirm `/admin` still works and a non-admin account still gets 403 there.
- [ ] Confirm the app still degrades gracefully for a non-Telegram visitor: open the raw URL in an ordinary desktop browser (outside Telegram) — the leaderboard/profile pages should render fine as a logged-out, read-only view (the bootstrap script no-ops when `window.Telegram.WebApp` isn't present); `/me/avatar` and `/admin` should show the "Открой это приложение через кнопку в Telegram-боте." message (Task 3's fix) rather than a broken redirect.

---

## Self-Review

**Spec coverage:** `verifyWebAppInitData` with the correct WebAppData-HMAC algorithm (✅ Task 1), `POST /tma/auth` + layout bootstrap script (✅ Task 2), removal of the old Login Widget entirely including `/logout` (✅ Task 3), tg-bot menu button with the JSON-stringify correction discovered by reading the actual installed library (✅ Task 4), manual deployment (✅ Task 5). No troll-bot changes anywhere (✅).

**Placeholder scan:** no TBD/TODO; every step has complete code or an exact command with expected output.

**Type consistency:** `verifyWebAppInitData(initData, botToken)` returns `number | null` — defined once in Task 1, consumed identically in Task 2's route (`if (!userId) ...`) and never changed again. `req.session.userId` remains a `Number`, matching every existing consumer (`getFighter(userId)`, `requireAdmin`'s `.includes(req.session.userId)` check) unchanged from before this plan.

**A gap caught during self-review, fixed inline rather than deferred:** deleting `/login` in Task 3 would have left `requireAuth`/`requireAdmin`'s `res.redirect('/login')` pointing at a route that no longer exists — a real, foreseeable break introduced by this very plan, not an external unknown. Task 3 now includes a dedicated step (Step 4) fixing both files to return a plain "open this from the bot" message instead of redirecting, before the old code is even removed. Task 5's manual pass confirms this live rather than discovering the gap for the first time there.
