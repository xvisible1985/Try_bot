# Пауза PvP (/pvpon, /pvpoff) Design

**Repo:** tg-bot only (`bot.js`). No troll-bot changes (troll-bot has its own separate `/fight` combat system and its own knockout mute — this pause flag lives entirely in tg-bot's own state and only gates tg-bot's own commands/jobs; troll-bot is out of scope).

**Goal:** Two admin-only commands, `/pvpon` and `/pvpoff`, that globally pause and resume the ENTIRE PvP subsystem — every combat/economy command, every PvP-related button, and every background job tied to it (crate drops, health/energy regen, the daily coin payout, bleed damage). While paused, every one of these refuses with a short "приостановлено" message instead of doing anything — including purely informational commands like `/me` or `/wallet`, per explicit confirmation that "nothing" should remain available.

## Why not `/start`/`/stop`

`/start` already exists (`bot.js:1132`) as the standard Telegram bot-greeting command (`"привет я бот"`), matched by the unanchored regex `/\/start/` — which would also match as a substring inside something like `/startpvp`, so no name containing `start` is safe to reuse or extend. `/stop` is free, but for symmetry both commands use a dedicated `pvp` prefix instead: **`/pvpon`** and **`/pvpoff`**.

## Storage

A new, generic key-value settings table — not knife/PvP-specific in its schema, so it can hold future on/off-style flags without another migration:

```sql
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT
)
```

The pause state is the row `key = 'pvp_paused'`, `value = '1'` (paused) or absent/`'0'` (not paused — the default, no row needed until first paused). Read directly from SQLite on every check, no in-memory cache — better-sqlite3 is synchronous and this is checked at most once per incoming command, so there's no performance reason to cache, and reading straight from disk means the flag is trivially correct across restarts with zero extra bootstrapping logic.

```js
function isPvpPaused() {
  const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'pvp_paused'").get();
  return !!row && row.value === '1';
}
```

## `/pvpon` / `/pvpoff` commands

Admin-only (`isAdmin(msg)`, the same helper already gating every other admin command in this file — e.g. `/mute`, the animal-role commands), no chat restriction (matches how every other admin command in this file behaves — none of them are confined to a specific chat). Reply goes to the chat the command was run in, same as every other admin command's own confirmation reply — no separate cross-post to `ARENA_CHAT_ID`.

```js
bot.onText(/\/pvpoff\b/i, async (msg) => {
  if (!await isAdmin(msg)) return;
  db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('pvp_paused', '1')").run();
  bot.sendMessage(msg.chat.id, '⛔ PvP-бои приостановлены.', threadOpts(msg)).catch(() => {});
});

bot.onText(/\/pvpon\b/i, async (msg) => {
  if (!await isAdmin(msg)) return;
  db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('pvp_paused', '0')").run();
  bot.sendMessage(msg.chat.id, '✅ PvP-бои снова разрешены.', threadOpts(msg)).catch(() => {});
});
```

(`INSERT OR REPLACE` — the same idiom this file already uses elsewhere, e.g. the animal-role commands' `INSERT OR REPLACE INTO animals` — rather than an `ON CONFLICT` clause, for consistency.)

Placed near the other PvP commands (e.g. right before `/warrior`), alongside `isPvpPaused()` and the `bot_settings` table creation.

## What gets gated

One line, first thing inside the handler (before any other check — including the existing chat/warrior/cooldown checks each command already has, so "PvP is off" always wins over any more specific refusal):

```js
if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
```

Applied as the first line of these 15 command handlers (every PvP-touching command in the file except `/helppvp`, see below):

`/me`, `/hide`, `/find`, `/levelup`, `/warrior`, `/wallet`, `/warriors`, `/pick`, `/inventory`, `/restore`, `/recharge`, `/shop`, `/give`, `/kick` (covers `/kick1`–`/kick3` too, same handler), `/defend`, `/kuniFun`, `/kuniAlia`, `/kuniTama`.

**`callback_query` handler** (`bot.js:3770`): this single handler exclusively serves PvP callback data (`levelup:`, `gv_i:`, `gv_y:`/`gv_n:`, `steal_coins:`, `shop:*`, `steal_yes:`/`steal_no:` — confirmed no non-PvP callback data is routed through it), so it gets exactly one guard at the very top, before the first `data.startsWith(...)` check:

```js
bot.on('callback_query', async (query) => {
  const data = query.data;
  if (isPvpPaused()) return bot.answerCallbackQuery(query.id, { text: 'PvP сейчас приостановлен', show_alert: true }).catch(() => {});
  // ... existing branches unchanged
```

(Exact insertion point depends on where `data` is currently first read in the handler — the guard goes immediately after that, before the first `if (data.startsWith(...))`.)

**Background jobs** — each gets an early return at the very top of its tick function, so it does nothing at all (no side effects, no messages) for the duration of a pause:

- `healthRegenTick` (`bot.js:4245`) — health regen, energy regen, and the daily 10-coin payout all live inside this one function, so gating its entry point stops all three at once.
- `arenaTick` (`bot.js:4314`) — crate decay/knife decay and the crate-drop announcement ("подарки с неба").
- `bleedTick` (`bot.js:4384`) — scissors' bleed-over-time damage. Gated too so a bleed already in progress when `/pvpoff` runs freezes rather than continuing to tick down; it resumes ticking (from wherever its own expiry timer was) once `/pvpon` runs.

```js
function healthRegenTick() {
  if (isPvpPaused()) return;
  // ... existing body unchanged
```

(Same one-line pattern for `arenaTick` and `bleedTick`.)

## What stays available: `/helppvp` only

`/helppvp` is pure static text — it reads no state and mutates nothing, so leaving it reachable during a pause costs nothing and lets people still read what each command does while waiting for PvP to resume. Every other command that touches PvP state in any way (including read-only ones like `/me`/`/wallet`/`/find`/`/warriors`/`/inventory`) is gated, per explicit confirmation that nothing else should remain available.

## Message texts

- `/pvpoff` confirmation (to the admin): `⛔ PvP-бои приостановлены.`
- `/pvpon` confirmation (to the admin): `✅ PvP-бои снова разрешены.`
- Any gated command, while paused: `⛔ PvP-бои сейчас приостановлены.`
- Any gated button click, while paused: alert toast `PvP сейчас приостановлен` (no message edit — the underlying message/keyboard is left exactly as it was, so it's still actionable once resumed).

## Out of scope

- No auto-expiring pause (stays paused until an admin explicitly runs `/pvpon`).
- No per-chat scoping — one global flag for the whole bot.
- No troll-bot changes — troll-bot's own `/fight` and knockout-mute system is untouched.
- No announcement to `ARENA_CHAT_ID` beyond the admin's own confirmation reply in whatever chat they ran the command from.
