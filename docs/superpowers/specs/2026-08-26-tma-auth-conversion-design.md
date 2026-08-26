# Telegram Mini App Auth Conversion Design

**Repos:** `tg-web` (c:\Users\123\Projects\tg-web — the auth rework) and `tg-bot` (c:\Users\123\Projects\tg-bot's `bot.js` — a small, separate addition: a persistent menu button launching the Mini App). No troll-bot changes.

**Goal:** Replace tg-web's Telegram Login Widget (a separate website, visited via a normal browser tab, requiring an explicit "Войти через Telegram" click) with Telegram Mini App auth — the app opens embedded inside Telegram itself, launched via a persistent menu button, and identifies the visitor automatically via Telegram's own signed `initData`, with no visible login step at all.

## Why this is a real rework, not a tweak

Telegram Mini Apps and the Login Widget are two different mechanisms with different signing algorithms and different payload shapes:

- **Login Widget** (what's currently built): the widget itself redirects the browser to a callback URL with flat query params (`id`, `first_name`, `username`, `auth_date`, `hash`). Signature: `secret_key = SHA256(bot_token)`, `hash = HMAC_SHA256(secret_key, data_check_string)`.
- **Mini App `initData`** (what this converts to): a raw, URL-encoded query string Telegram hands the page automatically via `window.Telegram.WebApp.initData` on load — no click, no redirect. One of its fields, `user`, is itself a JSON string (`{"id":123,"first_name":"Vasya",...}`) that must be parsed after verification to get the numeric id. Signature: `secret_key = HMAC_SHA256("WebAppData", bot_token)` (note: HMAC, not plain SHA256, and a different fixed string as the "message"), `hash = HMAC_SHA256(secret_key, data_check_string)`.

Everything downstream of "we now know this session belongs to Telegram user X" — `requireAuth`, `requireAdmin`, avatar upload, the admin weapon-icon panel, `web.db`, the leaderboard/profile pages themselves — is completely unaffected. This is a swap of exactly one thing: how `req.session.userId` gets set in the first place.

## tg-web changes

**New file `lib/telegramWebApp.js`** — `verifyWebAppInitData(initData, botToken)`:
1. Parse `initData` as a URL query string (`URLSearchParams`).
2. Remove `hash`; build the check-string from every remaining key, sorted alphabetically, `key=value` lines joined by `\n` (values as decoded by `URLSearchParams`, matching Telegram's documented algorithm).
3. `secretKey = HMAC_SHA256(key: "WebAppData", data: botToken)`.
4. `computedHash = HMAC_SHA256(key: secretKey, data: checkString)`, hex.
5. Constant-time-compare against the received `hash`; reject on mismatch (same `crypto.timingSafeEqual` pattern as `lib/telegramAuth.js`).
6. Check `auth_date` freshness — reject if older than 1 hour. (Tighter than the Login Widget's 24h window: Mini App `initData` is generated fresh by Telegram every time the app is opened, not something a user would reasonably present hours later, so a short window reduces the value of a leaked/logged `initData` string without costing real users anything — they get a fresh one on every open anyway.)
7. On success, `JSON.parse` the `user` field and return its numeric `id`; return `null`/throw on any failure at any step above.

**New route `POST /tma/auth`:**
```js
app.post('/tma/auth', express.json(), (req, res) => {
  const userId = verifyWebAppInitData(req.body.initData, process.env.TG_BOT_TOKEN);
  if (!userId) return res.status(403).json({ ok: false });
  req.session.userId = userId;
  res.json({ ok: true });
});
```
(`express.json()` is new to this app — nothing currently parses JSON request bodies; the existing upload routes use `multipart/form-data` via multer instead.)

**`views/layout.js`** (the shared shell present on every page) gains, near the closing `</body>`:
```html
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
```
Runs on every page load. If there's no Telegram context (e.g. someone finds the raw URL and opens it in a normal browser) it's a silent no-op — the page just renders as an anonymous visitor, same as today's public leaderboard/profile pages already do for logged-out users. If a session cookie already exists (valid for 30 days, matching the existing `cookieSession` `maxAge`), it skips the round-trip entirely — no repeated auth calls on every navigation. Exactly one reload happens, on first-ever open, then never again until the cookie expires.

**Removed:** `views/login.js`, the `/login` and `/login/callback` routes, `lib/telegramAuth.js`'s `verifyTelegramLogin` (superseded by `lib/telegramWebApp.js`), `TG_BOT_USERNAME` env var (only ever needed for the Login Widget's `data-telegram-login` attribute). `/logout` is also removed — with automatic re-auth on every open, a manual logout would just be silently re-established the next time the Mini App is opened, so it has no real effect and no route depends on it existing.

`TG_BOT_TOKEN` is kept (still needed for the new verification) and `ADMIN_USER_IDS`/`SESSION_SECRET`/`GAME_DB_PATH`/`PORT`/`NODE_ENV` are all unchanged.

## tg-bot changes (`bot.js`)

One new env var, `WEB_APP_URL` (via the `dotenv`/`process.env` pattern already used for `BOT_TOKEN`/`PROXY_URL`), and one call near bot startup:
```js
bot.setChatMenuButton({
  menu_button: { type: 'web_app', text: 'Боец', web_app: { url: process.env.WEB_APP_URL } },
}).catch(err => console.error('setChatMenuButton failed:', err.message));
```
This sets a global default menu button (shown to every user, in every private chat with the bot) pointing at tg-web. It's idempotent — safe to call on every boot, Telegram just keeps the setting as-is if unchanged. No new command, no change to `/me`/`/warriors`/any existing handler.

**To verify at deployment time, not assumed here:** whether Telegram currently requires any `@BotFather` configuration (domain allowlist, a registered Mini App short name, etc.) before a `web_app`-type menu button set via the Bot API will actually open for users, or whether a plain HTTPS URL is sufficient on its own. Historically this requirement applied to the Login Widget and to direct `t.me/<bot>/<shortname>` Mini App links, not to a Bot-API-set menu button — but Telegram's rules here have shifted before and should be re-checked against current documentation during the deployment task rather than assumed correct from this design.

## Out of scope

- Any UI change beyond the invisible auth bootstrap script — the leaderboard/profile/avatar/admin pages themselves are unchanged.
- A "logout" concept — deliberately removed, not deferred; re-opening the Mini App is Telegram's own re-authentication.
- Supporting the app being used outside Telegram (a direct browser visit) as anything other than an anonymous, logged-out view — this was the explicit, deliberate trade-off of removing the Login Widget entirely.
