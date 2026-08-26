# Fighter Web Profile MVP Design

**Repo:** new, separate from `tg-bot`/`troll-bot` — `c:\Users\123\Projects\tg-web` locally, its own deploy on the same VPS. No changes to `bot.js` in either existing repo.

**Goal:** First slice of a "Web 2.0" front-end for the PvP game: a public fighter profile page and a leaderboard, both read-only, no login required to view. Ships alongside — not instead of — the two Telegram bots, which keep running unchanged and remain the only way to actually play.

**Why this slice first:** it's the smallest piece that's visibly "the web version" (real images, a real page, shareable links) while touching zero live game state — nothing here can break a fight in progress. Everything else (the PvP fight itself on the web, a shared chat) is explicitly out of scope and would be its own later spec.

## Architecture

Three logically separate pieces:

1. **Read-only game-data access.** A `better-sqlite3` connection to tg-bot's existing `mutes.db`, opened with `{ readonly: true, fileMustExist: true }` — the same file troll-bot already opens concurrently from its own process, so a third read-only connection is a well-established pattern here, not a new risk. This connection is NEVER used for a write — no `INSERT`/`UPDATE`/`DELETE` against this file exists anywhere in this new codebase. `readonly: true` makes better-sqlite3 itself refuse a write attempt at the driver level, so this isn't just a convention, it's enforced.

2. **The web app's own SQLite database** (`web.db`, brand new, lives only in this new repo) — holds everything the web app needs to remember that the game itself doesn't: uploaded avatars, weapon-icon assignments, login sessions. tg-bot and troll-bot never read or write this file.

3. **Express server** — routes, Telegram Login verification, file upload handling, and rendering. Runs as a third pm2 process on the same VPS, its own port, reverse-proxied by whatever the VPS already uses for HTTPS/domain (out of scope here — a deployment detail to sort out with the user when the time comes, not a design question).

```
tg-bot (existing)  ──┐
                      ├──> mutes.db (read-only from here on)
troll-bot (existing)──┘

tg-web (new) ──> reads mutes.db (readonly connection)
             ──> reads/writes its own web.db
```

## Data read from `mutes.db` (all read-only)

- `pvp_stats`: `xp` (level shown as `floor(xp/100)`), `accuracy`/`strength`/`agility`/`endurance`, `coins`, `is_warrior`, `crit_count`.
- `user_health`: `health`/`max_health`, `energy`/`max_energy`, `hospitalized_since` (shown as a "в больничке" badge if set and health < 30, mirroring the bot's own `isHospitalized` rule), `bleed_until` (shown as a "кровоточит" badge if in the future).
- `weapon_ownership` + `owned_knives`: same query shape as the bot's own `getWeaponsFor` — singleton weapons by `weapon_key`, knives individually by row, each becomes one inventory slot on the profile.
- `injuries`: active injury type + human-readable remaining time, if `injured_until` is in the future.
- Non-warriors (`is_warrior = 0`) are excluded from the leaderboard entirely and their profile page shows a simple "ещё не воин" state instead of stats — matches the bot's own gate on who's a real fighter.

Nothing from `buffs` (defend/kuni* cooldowns) is shown — those are short-lived combat-moment states, not meaningful on a profile someone might view minutes or hours later.

## Pages

- **`GET /`** — leaderboard. Podium (top 3, large) + plain list below (rest, sorted by `xp` descending — same ordering the bot's own `/warriors` uses). Each row/card links to that fighter's profile.
- **`GET /fighter/:id`** — profile, RPG character-sheet layout: avatar + level on the left, attributes/health/energy/coins and inventory (weapon icons) on the right, status badges (больничка/bleed/injury) if applicable.
- **`GET /login`** — Telegram Login Widget. On success, Telegram redirects back with signed user data; the server verifies the signature using tg-bot's own bot token (HMAC-SHA256 over the returned fields, per Telegram's documented login-widget verification algorithm) and, if valid, sets a signed session cookie containing that Telegram `user_id`. No new bot is created for this — the widget can be configured against tg-bot's existing `@BotFather` entry (`/setdomain`) without touching its polling/webhook setup at all.
- **`GET /me/avatar`** (must be logged in) — small upload form.
- **`POST /me/avatar`** (must be logged in) — saves the uploaded image as `uploads/avatars/<telegram_user_id>.jpg`, overwriting any previous one, and records it in `web.db`. A user can only ever write to the path matching their OWN verified session `user_id` — there is no field or parameter anywhere that lets a request target a different user's avatar.
- **`GET /admin`** (must be logged in AND `user_id` in a hardcoded `ADMIN_USER_IDS` allowlist — the actual Telegram user_id(s) to put in this list need to come from the user before implementation starts) — one row per weapon type (bat/axe/scissors/knife/carrot/horns/crutch) with its current icon (if any) and an upload control.
- **`POST /admin/weapon-icon`** (same admin gate) — saves as `uploads/weapons/<weapon_key>.jpg`, records in `web.db`. This endpoint's ONLY effect is which image file is associated with a `weapon_key` string for display purposes — it never touches `weapon_ownership`, never changes who holds what in the live game.

## `web.db` schema (new, this repo only)

```sql
CREATE TABLE avatars (
  user_id INTEGER PRIMARY KEY,
  image_path TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE TABLE weapon_icons (
  weapon_key TEXT PRIMARY KEY,
  image_path TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
```

No sessions table — sessions are a signed cookie (e.g. `cookie-session`), not server-side state, since the only thing worth remembering is "which Telegram user_id is this."

## Tech choices

- **Express** + server-rendered templates (plain template strings or a minimal templating engine like EJS — no decision needed yet beyond "no client-side framework, no build step"), matching the existing bots' own "no framework" style. Keeps the whole thing deployable as one more plain `node index.js` pm2 process, no separate frontend build/deploy pipeline to maintain.
- **`multer`** for handling the two file-upload endpoints (avatar, weapon icon) — the one new, standard, small dependency this slice needs beyond what the bots already use (`better-sqlite3` is shared).
- Uploaded images are stored directly on the VPS filesystem under `uploads/`, served back out as static files by the same Express process (`express.static`). No object storage, no CDN — traffic and image count are both tiny at this stage.
- Image validation: accept only `image/jpeg`/`image/png`/`image/webp`, cap file size (e.g. 2 MB) — rejected uploads just re-show the form with an error, no further processing (no resizing/cropping) in this slice.

## Out of scope (explicitly, for this spec)

- Actual PvP combat on the web (attacking, shop, inventory management) — a later spec, once this slice is live.
- Shared real-time chat — unrelated to fighter data, its own later spec.
- Any write path from the web app into `mutes.db` — not now, not ever without a dedicated, separately-reviewed design, given that file is live game state shared with two running bots.
- Editing weapon ownership, health, coins, or any other live stat from the web — the admin panel only ever touches `web.db`.
- Avatar moderation/approval queue — a fighter's own upload goes live immediately, same trust level as any other self-service upload in this game (matches how the bots let players freely name/style themselves already).
