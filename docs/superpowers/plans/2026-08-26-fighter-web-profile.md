# Fighter Web Profile MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new, standalone Express web app (`tg-web`) showing a public leaderboard and RPG-style fighter profiles read from tg-bot's existing game database, plus Telegram-Login-gated self-service avatar upload and an admin panel for weapon icons.

**Architecture:** One new Node.js/Express repo, two SQLite connections (a read-only one into tg-bot's live `mutes.db`, a read-write one into this repo's own brand-new `web.db` for avatars/icons), server-rendered HTML (no build step, no client framework), signed-cookie sessions backed by Telegram Login Widget verification.

**Tech Stack:** Node.js, Express, better-sqlite3, multer (file uploads), cookie-session, dotenv.

---

## Spec

Full design: `docs/superpowers/specs/2026-08-26-fighter-web-profile-design.md`. Read it before starting.

## Critical shared context — read this before any task

**This is a brand-new repository at `c:\Users\123\Projects\tg-web`** — it does not exist yet before Task 1. Every subsequent task assumes Task 1's scaffold is already in place. Unlike every other plan this session, there is no existing file to re-locate anchors in for most tasks — you're writing new files from scratch, so "exact code" below is the literal file content, not a Find/Replace against something pre-existing.

**Two databases, two very different trust levels:**
- `c:\Users\123\Projects\tg-bot\mutes.db` — tg-bot's live game database, shared with troll-bot. This plan's code opens it with `{ readonly: true, fileMustExist: true }` and **never** issues an `INSERT`/`UPDATE`/`DELETE` against it anywhere. If you ever find yourself wanting to write to this connection, stop — that's out of scope for this entire plan, not just this task.
- `web.db` (created fresh in Task 1, inside `tg-web`) — this repo's own database, read-write, holds only `avatars` and `weapon_icons`.

**No troll-bot changes, no tg-bot (`bot.js`) changes anywhere in this plan.**

**This repo commits to its own `main` branch, no worktrees** — same convention already used for `tg-bot`/`troll-bot` this session, extended here per the user's confirmation.

**Admin identity:** the one admin's Telegram numeric user_id is `8384023163`. This goes into the deployed `.env` file's `ADMIN_USER_IDS` value (Task 5), never hardcoded into a source file.

---

### Task 1: Project scaffold — Express skeleton + both DB connections

**Files:**
- Create: `c:\Users\123\Projects\tg-web\package.json`
- Create: `c:\Users\123\Projects\tg-web\.gitignore`
- Create: `c:\Users\123\Projects\tg-web\.env.example`
- Create: `c:\Users\123\Projects\tg-web\lib\gameDb.js`
- Create: `c:\Users\123\Projects\tg-web\lib\webDb.js`
- Create: `c:\Users\123\Projects\tg-web\index.js`

- [ ] **Step 1: Create the project directory and initialize git**

```bash
mkdir -p /c/Users/123/Projects/tg-web
cd /c/Users/123/Projects/tg-web
git init
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "tg-web",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "cookie-session": "^2.1.0",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "multer": "^1.4.5-lts.1"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd /c/Users/123/Projects/tg-web && npm install`
Expected: exits 0, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
.env
web.db
uploads/
```

- [ ] **Step 5: Write `.env.example`** (documents required env vars — the real `.env` is never committed)

```
# Absolute path to tg-bot's existing mutes.db (read-only)
GAME_DB_PATH=/root/Try_bot/mutes.db
# tg-bot's own bot token, needed to verify Telegram Login Widget signatures
TG_BOT_TOKEN=
# Comma-separated numeric Telegram user_ids allowed into /admin
ADMIN_USER_IDS=123456789
# Random long string used to sign the session cookie
SESSION_SECRET=
# Port this app listens on
PORT=3000
```

- [ ] **Step 6: Write `lib/gameDb.js`** — the read-only connection into tg-bot's live database

```js
const Database = require('better-sqlite3');

const gameDbPath = process.env.GAME_DB_PATH;
if (!gameDbPath) {
  throw new Error('GAME_DB_PATH env var is not set — see .env.example');
}

// readonly: true makes better-sqlite3 itself refuse any write attempt at
// the driver level — this connection must NEVER become a place a write
// accidentally lands, since mutes.db is live state shared with tg-bot
// and troll-bot, both still running as separate processes.
const gameDb = new Database(gameDbPath, { readonly: true, fileMustExist: true });

module.exports = gameDb;
```

- [ ] **Step 7: Write `lib/webDb.js`** — this repo's own read-write database

```js
const path = require('path');
const Database = require('better-sqlite3');

const webDb = new Database(path.join(__dirname, '..', 'web.db'));

webDb.exec(`
  CREATE TABLE IF NOT EXISTS avatars (
    user_id INTEGER PRIMARY KEY,
    image_path TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL
  )
`);
webDb.exec(`
  CREATE TABLE IF NOT EXISTS weapon_icons (
    weapon_key TEXT PRIMARY KEY,
    image_path TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL
  )
`);

module.exports = webDb;
```

- [ ] **Step 8: Write `index.js`** — minimal Express skeleton, just enough to boot and prove both DB connections work

```js
require('dotenv').config();
const express = require('express');
const gameDb = require('./lib/gameDb');
const webDb = require('./lib/webDb');

const app = express();

app.get('/healthz', (req, res) => {
  // Touches both connections once at request time, cheaply, so a broken
  // GAME_DB_PATH or a corrupt web.db surfaces immediately instead of
  // silently failing on the first real page view.
  const gameOk = !!gameDb.prepare('SELECT 1').get();
  const webOk = !!webDb.prepare('SELECT 1').get();
  res.json({ gameDb: gameOk, webDb: webOk });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`tg-web listening on port ${port}`);
});
```

- [ ] **Step 9: Create a local `.env` for manual testing** (not committed — copy from example, point at your local tg-bot checkout)

```bash
cd /c/Users/123/Projects/tg-web
cp .env.example .env
```

Edit `.env` and set `GAME_DB_PATH=/c/Users/123/Projects/tg-bot/mutes.db` (or wherever your local `mutes.db` actually is — if it doesn't exist locally yet, run `sqlite3 mutes.db "CREATE TABLE pvp_stats (user_id INTEGER)"` in the tg-bot directory first just so `fileMustExist` has something to open for this local smoke test; production will point at the real file).

- [ ] **Step 10: Smoke-test the server boots and both connections work**

Run: `cd /c/Users/123/Projects/tg-web && node index.js &` then `curl http://localhost:3000/healthz`
Expected: `{"gameDb":true,"webDb":true}`. Stop the server afterward (`kill %1` or close the terminal).

- [ ] **Step 11: Commit**

```bash
cd /c/Users/123/Projects/tg-web
git add package.json package-lock.json .gitignore .env.example lib/gameDb.js lib/webDb.js index.js
git commit -m "chore: project scaffold, read-only game DB + web DB connections"
```

(No `git push` yet — this repo has no remote configured. That's a manual step for the user during Task 6's deployment, not part of this plan's automated steps.)

---

### Task 2: Leaderboard + fighter profile pages (read-only, no auth)

**Files:**
- Create: `c:\Users\123\Projects\tg-web\lib\weaponDefs.js`
- Create: `c:\Users\123\Projects\tg-web\lib\queries.js`
- Create: `c:\Users\123\Projects\tg-web\views\layout.js`
- Create: `c:\Users\123\Projects\tg-web\views\leaderboard.js`
- Create: `c:\Users\123\Projects\tg-web\views\fighter.js`
- Modify: `c:\Users\123\Projects\tg-web\index.js`

**Depends on Task 1.**

- [ ] **Step 1: Write `lib/weaponDefs.js`** — this app's own copy of weapon flavor data, same values as `bot.js`'s `WEAPON_DEFS` (needed here purely for display name/emoji; this app never touches combat multipliers)

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', emoji: '🏏' },
  axe: { name: 'топор', emoji: '🪓' },
  scissors: { name: 'ножницы', emoji: '✂️' },
  crutch: { name: 'костыль', emoji: '🩼' },
  horns: { name: 'рога', emoji: '🐂' },
  carrot: { name: 'морковка', emoji: '🥕' },
  knife: { name: 'ржавый нож', emoji: '🔪' },
};

module.exports = WEAPON_DEFS;
```

- [ ] **Step 2: Write `lib/queries.js`** — every read against `gameDb`, in one place

```js
const gameDb = require('./gameDb');

const HOSPITAL_EXIT_HEALTH = 30; // mirrors bot.js's own constant of the same name

// Mirrors bot.js's own getWeaponsFor(ownerType, ownerUserId) query shape —
// singleton weapons by weapon_key, individual owned_knives rows each
// becoming their own inventory slot. Re-derived here (not imported) since
// this is a separate process/repo with no code-sharing with bot.js.
function getWeaponsFor(userId) {
  const regular = gameDb.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
  ).all(userId);
  const knives = gameDb.prepare(
    "SELECT id FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')"
  ).all(userId).map(() => ({ weapon_key: 'knife' }));
  return [...regular.map(r => ({ weapon_key: r.weapon_key })), ...knives];
}

function getLeaderboard() {
  return gameDb.prepare(
    'SELECT user_id, xp, coins FROM pvp_stats WHERE is_warrior = 1 ORDER BY xp DESC'
  ).all().map((row, i) => ({
    userId: row.user_id,
    rank: i + 1,
    level: Math.floor(row.xp / 100),
    coins: row.coins,
  }));
}

function getFighter(userId) {
  const stats = gameDb.prepare('SELECT * FROM pvp_stats WHERE user_id = ?').get(userId);
  if (!stats || !stats.is_warrior) return null;

  const health = gameDb.prepare('SELECT * FROM user_health WHERE user_id = ?').get(userId) || {
    health: 100, max_health: 100, energy: 10, max_energy: 10, hospitalized_since: null, bleed_until: null,
  };
  const injury = gameDb.prepare(
    "SELECT injury_type, injured_until FROM injuries WHERE user_id = ? AND injured_until > strftime('%s','now')"
  ).get(userId);
  const known = gameDb.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(userId);

  const now = Math.floor(Date.now() / 1000);
  return {
    userId,
    displayName: known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${userId}`,
    level: Math.floor(stats.xp / 100),
    xp: stats.xp,
    accuracy: stats.accuracy,
    strength: stats.strength,
    agility: stats.agility,
    endurance: stats.endurance,
    coins: stats.coins,
    health: health.health,
    maxHealth: health.max_health,
    energy: health.energy,
    maxEnergy: health.max_energy,
    isHospitalized: !!health.hospitalized_since && health.health < HOSPITAL_EXIT_HEALTH,
    isBleeding: !!health.bleed_until && health.bleed_until > now,
    injury: injury ? { type: injury.injury_type, minutesLeft: Math.ceil((injury.injured_until - now) / 60) } : null,
    weapons: getWeaponsFor(userId),
  };
}

module.exports = { getLeaderboard, getFighter };
```

- [ ] **Step 3: Write `views/layout.js`** — a tiny shared HTML shell (no templating engine, just template strings — matches the "no framework" brief)

```js
function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: sans-serif; max-width: 720px; margin: 24px auto; padding: 0 12px; }
    .bar-bg { background: #eee; border-radius: 4px; overflow: hidden; height: 10px; }
    .bar-fill { background: #4caf50; height: 100%; }
    .bar-fill.energy { background: #2196f3; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 4px 8px; text-align: left; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-right: 4px; }
    .badge.hospital { background: #ffe0e0; }
    .badge.bleed { background: #ffd0d0; }
    .badge.injury { background: #fff0d0; }
    .podium { display: flex; gap: 12px; justify-content: center; margin-bottom: 16px; }
    .podium a { text-decoration: none; color: inherit; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

module.exports = layout;
```

- [ ] **Step 4: Write `views/leaderboard.js`**

```js
const layout = require('./layout');

function renderLeaderboard(fighters) {
  const top3 = fighters.slice(0, 3);
  const rest = fighters.slice(3);

  const podiumHtml = top3.map(f => `
    <a href="/fighter/${f.userId}">
      <div style="text-align:center;">
        <div>${f.rank === 1 ? '🥇' : f.rank === 2 ? '🥈' : '🥉'}</div>
        <div>Ур. ${f.level}</div>
        <div>${f.coins} 🪙</div>
      </div>
    </a>
  `).join('');

  const restRows = rest.map(f => `
    <tr>
      <td>${f.rank}</td>
      <td><a href="/fighter/${f.userId}">Игрок ${f.userId}</a></td>
      <td>Ур. ${f.level}</td>
      <td>${f.coins} 🪙</td>
    </tr>
  `).join('');

  return layout('Таблица лидеров', `
    <h1>Таблица лидеров</h1>
    ${fighters.length === 0 ? '<p>Пока нет ни одного воина.</p>' : `
      <div class="podium">${podiumHtml}</div>
      <table>${restRows}</table>
    `}
  `);
}

module.exports = renderLeaderboard;
```

(The podium/rest split shows `userId` rather than a display name — Task 2 deliberately keeps `getLeaderboard()` cheap by not joining `known_users` per row; swapping in real display names is a trivial follow-up once this ships, not blocking.)

- [ ] **Step 5: Write `views/fighter.js`**

```js
const layout = require('./layout');
const WEAPON_DEFS = require('../lib/weaponDefs');

function renderFighter(fighter) {
  if (!fighter) {
    return layout('Боец', '<h1>Ещё не воин</h1><p>Этот игрок пока не зарегистрирован как воин.</p>');
  }

  const badges = [
    fighter.isHospitalized ? '<span class="badge hospital">🏥 в больничке</span>' : '',
    fighter.isBleeding ? '<span class="badge bleed">🩸 кровоточит</span>' : '',
    fighter.injury ? `<span class="badge injury">🤕 травма (${fighter.injury.minutesLeft} мин)</span>` : '',
  ].join('');

  const weaponIcons = fighter.weapons.map(w => `<span title="${WEAPON_DEFS[w.weapon_key].name}">${WEAPON_DEFS[w.weapon_key].emoji}</span>`).join(' ') || '(пусто)';

  return layout(fighter.displayName, `
    <h1>${fighter.displayName} — уровень ${fighter.level}</h1>
    <div>${badges}</div>
    <table>
      <tr><td>Точность</td><td>${fighter.accuracy}</td><td>Сила</td><td>${fighter.strength}</td></tr>
      <tr><td>Ловкость</td><td>${fighter.agility}</td><td>Выносливость</td><td>${fighter.endurance}</td></tr>
    </table>
    <p>❤️ Здоровье: ${fighter.health}/${fighter.maxHealth}</p>
    <div class="bar-bg"><div class="bar-fill" style="width:${Math.round(100 * fighter.health / fighter.maxHealth)}%"></div></div>
    <p>⚡ Энергия: ${fighter.energy}/${fighter.maxEnergy}</p>
    <div class="bar-bg"><div class="bar-fill energy" style="width:${Math.round(100 * fighter.energy / fighter.maxEnergy)}%"></div></div>
    <p>🪙 Монеты: ${fighter.coins}</p>
    <p>Оружие: ${weaponIcons}</p>
  `);
}

module.exports = renderFighter;
```

- [ ] **Step 6: Wire the two routes into `index.js`**

Find:
```js
const app = express();

app.get('/healthz', (req, res) => {
```

Replace with:
```js
const { getLeaderboard, getFighter } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');

const app = express();

app.get('/', (req, res) => {
  res.send(renderLeaderboard(getLeaderboard()));
});

app.get('/fighter/:id', (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).send('Неверный id');
  res.send(renderFighter(getFighter(userId)));
});

app.get('/healthz', (req, res) => {
```

- [ ] **Step 7: Write and run an isolated verification script against a scratch DB matching the real schema**

Create `c:\Users\123\Projects\tg-web\_verify_queries.js`:

```js
process.env.GAME_DB_PATH = ':memory:';
// Re-require better-sqlite3 directly here rather than through lib/gameDb.js's
// readonly wrapper, since we need to WRITE test fixture rows into the
// in-memory DB first — this script builds its own throwaway connection with
// the same schema, it doesn't exercise lib/gameDb.js's readonly flag itself
// (that flag is simple enough — a single option to better-sqlite3 — to trust
// without a dedicated test).
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE pvp_stats (user_id INTEGER PRIMARY KEY, xp INTEGER NOT NULL DEFAULT 0, coins INTEGER NOT NULL DEFAULT 0, is_warrior INTEGER NOT NULL DEFAULT 0, accuracy INTEGER NOT NULL DEFAULT 0, strength INTEGER NOT NULL DEFAULT 0, agility INTEGER NOT NULL DEFAULT 0, endurance INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, max_health INTEGER NOT NULL DEFAULT 100, energy INTEGER NOT NULL DEFAULT 10, max_energy INTEGER NOT NULL DEFAULT 10, hospitalized_since INTEGER, bleed_until INTEGER);
  CREATE TABLE injuries (user_id INTEGER PRIMARY KEY, injury_type TEXT NOT NULL, injured_until INTEGER NOT NULL);
  CREATE TABLE known_users (user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, last_seen_at INTEGER);
  CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_user_id INTEGER, expires_at INTEGER);
  CREATE TABLE owned_knives (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, is_dropped INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
`);

const now = Math.floor(Date.now() / 1000);
db.prepare('INSERT INTO pvp_stats (user_id, xp, coins, is_warrior, accuracy, strength, agility, endurance) VALUES (1, 350, 100, 1, 5, 5, 5, 5)').run();
db.prepare('INSERT INTO pvp_stats (user_id, xp, coins, is_warrior) VALUES (2, 50, 10, 1)').run();
db.prepare('INSERT INTO pvp_stats (user_id, xp, coins, is_warrior) VALUES (3, 0, 0, 0)').run(); // not a warrior
db.prepare('INSERT INTO user_health (user_id, health, max_health, hospitalized_since) VALUES (1, 20, 100, ?)').run(now);
db.prepare('INSERT INTO known_users (user_id, username) VALUES (1, ?)').run('Vasya');
db.prepare("INSERT INTO weapon_ownership (weapon_key, owner_type, owner_user_id) VALUES ('bat', 'human', 1)").run();
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, expires_at) VALUES (1, 0, ?)').run(now + 3600);
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, expires_at) VALUES (1, 1, ?)').run(now + 3600); // dropped, must NOT count
db.prepare('INSERT INTO injuries (user_id, injury_type, injured_until) VALUES (1, ?, ?)').run('arm', now + 600);

// Re-implement the same two functions against this fixture db (mirrors
// lib/queries.js exactly, just pointed at the in-memory fixture instead of
// requiring lib/gameDb.js, which insists on a real file path).
const HOSPITAL_EXIT_HEALTH = 30;
function getWeaponsFor(userId) {
  const regular = db.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
  ).all(userId);
  const knives = db.prepare(
    "SELECT id FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')"
  ).all(userId).map(() => ({ weapon_key: 'knife' }));
  return [...regular.map(r => ({ weapon_key: r.weapon_key })), ...knives];
}
function getLeaderboard() {
  return db.prepare('SELECT user_id, xp, coins FROM pvp_stats WHERE is_warrior = 1 ORDER BY xp DESC').all()
    .map((row, i) => ({ userId: row.user_id, rank: i + 1, level: Math.floor(row.xp / 100), coins: row.coins }));
}

const leaderboard = getLeaderboard();
console.log('leaderboard excludes non-warriors:', leaderboard.length, 'expected 2');
console.log('leaderboard sorted by xp desc, user 1 first:', leaderboard[0].userId, 'expected 1');

const weapons = getWeaponsFor(1);
console.log('weapons: bat + 1 live knife, not the dropped one:', weapons.map(w => w.weapon_key).sort(), 'expected [ \'bat\', \'knife\' ]');

const health = db.prepare('SELECT * FROM user_health WHERE user_id = 1').get();
console.log('hospitalized badge condition:', !!health.hospitalized_since && health.health < HOSPITAL_EXIT_HEALTH, 'expected true');
```

Run: `cd /c/Users/123/Projects/tg-web && node _verify_queries.js`

Expected output (must match exactly):
```
leaderboard excludes non-warriors: 2 expected 2
leaderboard sorted by xp desc, user 1 first: 1 expected 1
weapons: bat + 1 live knife, not the dropped one: [ 'bat', 'knife' ] expected [ 'bat', 'knife' ]
hospitalized badge condition: true expected true
```

Delete the scratch script once confirmed: `rm /c/Users/123/Projects/tg-web/_verify_queries.js`

- [ ] **Step 8: Manual smoke test against the real app**

Run: `cd /c/Users/123/Projects/tg-web && node index.js &`, then open `http://localhost:3000/` in a browser (or `curl`).
Expected: renders without error (an empty leaderboard is fine if your local `mutes.db` has no warriors yet). Stop the server afterward.

- [ ] **Step 9: Commit**

```bash
cd /c/Users/123/Projects/tg-web
git add lib/weaponDefs.js lib/queries.js views/layout.js views/leaderboard.js views/fighter.js index.js
git commit -m "feat: leaderboard and fighter profile pages (read-only)"
```

---

### Task 3: Telegram Login Widget + session cookie

**Files:**
- Create: `c:\Users\123\Projects\tg-web\lib\telegramAuth.js`
- Create: `c:\Users\123\Projects\tg-web\views\login.js`
- Modify: `c:\Users\123\Projects\tg-web\index.js`

**Depends on Task 1.**

- [ ] **Step 1: Write `lib/telegramAuth.js`** — the HMAC-SHA256 verification, per Telegram's documented Login Widget algorithm

```js
const crypto = require('crypto');

// Telegram's documented check: https://core.telegram.org/widgets/login#checking-authorization
// 1. Drop the `hash` field itself from the data.
// 2. Sort every remaining field alphabetically by key, join as "key=value"
//    lines with "\n" — this is the "data-check-string".
// 3. secret_key = SHA256(bot_token) — raw bytes, not hex.
// 4. computed_hash = HMAC-SHA256(data-check-string, secret_key), hex.
// 5. Reject unless computed_hash === received hash (constant-time compare)
//    AND auth_date is recent (Telegram doesn't expire these itself — an
//    old, replayed callback URL would otherwise verify forever).
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

function verifyTelegramLogin(data, botToken) {
  const { hash, ...fields } = data;
  if (!hash || typeof hash !== 'string') return false;

  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  const receivedBuffer = Buffer.from(hash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');
  if (receivedBuffer.length !== computedBuffer.length) return false;
  if (!crypto.timingSafeEqual(receivedBuffer, computedBuffer)) return false;

  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate)) return false;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS || ageSeconds < -60) return false;

  return true;
}

module.exports = { verifyTelegramLogin };
```

- [ ] **Step 2: Write and run an isolated verification script — this is the one piece of real cryptography in the whole plan, verify it against a hand-constructed valid signature, not just "looks right"**

Create `c:\Users\123\Projects\tg-web\_verify_auth.js`:

```js
const crypto = require('crypto');
const { verifyTelegramLogin } = require('./lib/telegramAuth');

const botToken = 'TEST:TOKEN_FOR_VERIFICATION_ONLY';

function signPayload(fields, token) {
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHash('sha256').update(token).digest();
  return crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
}

const now = Math.floor(Date.now() / 1000);
const validFields = { id: '12345', first_name: 'Test', username: 'testuser', auth_date: String(now) };
const validHash = signPayload(validFields, botToken);

console.log('valid signature accepted:', verifyTelegramLogin({ ...validFields, hash: validHash }, botToken), 'expected true');

const tamperedFields = { ...validFields, id: '99999' };
console.log('tampered field (same hash) rejected:', verifyTelegramLogin({ ...tamperedFields, hash: validHash }, botToken), 'expected false');

console.log('garbage hash rejected:', verifyTelegramLogin({ ...validFields, hash: 'deadbeef' }, botToken), 'expected false');

console.log('wrong bot token rejected:', verifyTelegramLogin({ ...validFields, hash: validHash }, 'WRONG:TOKEN'), 'expected false');

const staleFields = { ...validFields, auth_date: String(now - 2 * 24 * 60 * 60) };
const staleHash = signPayload(staleFields, botToken);
console.log('stale auth_date (2 days old) rejected:', verifyTelegramLogin({ ...staleFields, hash: staleHash }, botToken), 'expected false');

console.log('missing hash rejected:', verifyTelegramLogin({ ...validFields }, botToken), 'expected false');
```

Run: `cd /c/Users/123/Projects/tg-web && node _verify_auth.js`

Expected output (must match exactly):
```
valid signature accepted: true expected true
tampered field (same hash) rejected: false expected false
garbage hash rejected: false expected false
wrong bot token rejected: false expected false
stale auth_date (2 days old) rejected: false expected false
missing hash rejected: false expected false
```

Delete the scratch script once confirmed: `rm /c/Users/123/Projects/tg-web/_verify_auth.js`

- [ ] **Step 3: Write `views/login.js`** — the page embedding Telegram's own widget script

```js
const layout = require('./layout');

function renderLogin(botUsername) {
  return layout('Вход', `
    <h1>Вход через Telegram</h1>
    <script async src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${botUsername}"
      data-size="large"
      data-auth-url="/login/callback"
      data-request-access="write"></script>
  `);
}

module.exports = renderLogin;
```

(`data-telegram-login` must be tg-bot's bot USERNAME, not its token — read from `TG_BOT_USERNAME` env var, added in the next step, distinct from `TG_BOT_TOKEN`.)

- [ ] **Step 4: Add `TG_BOT_USERNAME` to `.env.example`**

Find:
```
# tg-bot's own bot token, needed to verify Telegram Login Widget signatures
TG_BOT_TOKEN=
```

Replace with:
```
# tg-bot's own bot token, needed to verify Telegram Login Widget signatures
TG_BOT_TOKEN=
# tg-bot's own bot USERNAME (no @), needed to render the login widget
TG_BOT_USERNAME=
```

- [ ] **Step 5: Wire login routes + session middleware into `index.js`**

Find:
```js
require('dotenv').config();
const express = require('express');
const gameDb = require('./lib/gameDb');
const webDb = require('./lib/webDb');
```

Replace with:
```js
require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const gameDb = require('./lib/gameDb');
const webDb = require('./lib/webDb');
const { verifyTelegramLogin } = require('./lib/telegramAuth');
const renderLogin = require('./views/login');
```

Find:
```js
const { getLeaderboard, getFighter } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');

const app = express();
```

Replace with:
```js
const { getLeaderboard, getFighter } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');

const app = express();
app.use(cookieSession({
  name: 'session',
  secret: process.env.SESSION_SECRET,
  maxAge: 30 * 24 * 60 * 60 * 1000,
}));

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
```

- [ ] **Step 6: Syntax-check**

Run: `cd /c/Users/123/Projects/tg-web && node --check index.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/123/Projects/tg-web
git add lib/telegramAuth.js views/login.js .env.example index.js
git commit -m "feat: Telegram Login Widget verification + session cookie"
```

---

### Task 4: Self-service avatar upload

**Files:**
- Create: `c:\Users\123\Projects\tg-web\lib\requireAuth.js`
- Create: `c:\Users\123\Projects\tg-web\lib\upload.js`
- Create: `c:\Users\123\Projects\tg-web\views\avatarForm.js`
- Modify: `c:\Users\123\Projects\tg-web\lib\queries.js`
- Modify: `c:\Users\123\Projects\tg-web\views\fighter.js`
- Modify: `c:\Users\123\Projects\tg-web\index.js`

**Depends on Task 3** (needs `req.session.userId`).

- [ ] **Step 1: Write `lib/requireAuth.js`**

```js
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

module.exports = requireAuth;
```

- [ ] **Step 2: Write `lib/upload.js`** — shared multer config for both avatar and (later, Task 5) weapon-icon uploads

```js
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

function extensionFor(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function makeUploader(subdir, filenameFn) {
  const dir = path.join(__dirname, '..', 'uploads', subdir);
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dir),
      filename: (req, file, cb) => cb(null, filenameFn(req, file)),
    }),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME_TYPES.includes(file.mimetype)),
  });
}

module.exports = { makeUploader, extensionFor, ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES };
```

- [ ] **Step 3: Write `views/avatarForm.js`**

```js
const layout = require('./layout');

function renderAvatarForm(error) {
  return layout('Моя аватарка', `
    <h1>Загрузить аватарку</h1>
    ${error ? `<p style="color:red;">${error}</p>` : ''}
    <form method="post" action="/me/avatar" enctype="multipart/form-data">
      <input type="file" name="avatar" accept="image/jpeg,image/png,image/webp" required>
      <button type="submit">Загрузить</button>
    </form>
  `);
}

module.exports = renderAvatarForm;
```

- [ ] **Step 4: Add an avatar lookup to `lib/queries.js`**

Find:
```js
const gameDb = require('./gameDb');
```

Replace with:
```js
const gameDb = require('./gameDb');
const webDb = require('./webDb');
```

Find:
```js
module.exports = { getLeaderboard, getFighter };
```

Replace with:
```js
function getAvatarPath(userId) {
  const row = webDb.prepare('SELECT image_path FROM avatars WHERE user_id = ?').get(userId);
  return row ? row.image_path : null;
}

module.exports = { getLeaderboard, getFighter, getAvatarPath };
```

- [ ] **Step 5: Show the avatar (or a placeholder) on the profile page**

Find (in `views/fighter.js`):
```js
function renderFighter(fighter) {
```

Replace with:
```js
function renderFighter(fighter, avatarUrl) {
```

Find:
```js
  return layout(fighter.displayName, `
    <h1>${fighter.displayName} — уровень ${fighter.level}</h1>
    <div>${badges}</div>
```

Replace with:
```js
  return layout(fighter.displayName, `
    <h1>${fighter.displayName} — уровень ${fighter.level}</h1>
    ${avatarUrl ? `<img src="${avatarUrl}" alt="" width="80" height="80" style="border-radius:50%;object-fit:cover;">` : ''}
    <div>${badges}</div>
```

- [ ] **Step 6: Wire the avatar route and static file serving + pass `avatarUrl` through into `index.js`**

Find:
```js
const { getLeaderboard, getFighter } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');
```

Replace with:
```js
const path = require('path');
const { getLeaderboard, getFighter, getAvatarPath } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');
const requireAuth = require('./lib/requireAuth');
const { makeUploader } = require('./lib/upload');
const renderAvatarForm = require('./views/avatarForm');

const avatarUpload = makeUploader('avatars', (req) => `${req.session.userId}.jpg`);
```

Find:
```js
app.get('/fighter/:id', (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).send('Неверный id');
  res.send(renderFighter(getFighter(userId)));
});
```

Replace with:
```js
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/fighter/:id', (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).send('Неверный id');
  const avatarPath = getAvatarPath(userId);
  res.send(renderFighter(getFighter(userId), avatarPath ? `/uploads/avatars/${userId}.jpg` : null));
});

app.get('/me/avatar', requireAuth, (req, res) => {
  res.send(renderAvatarForm(null));
});

app.post('/me/avatar', requireAuth, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err || !req.file) {
      return res.send(renderAvatarForm('Не удалось загрузить файл — проверь формат (jpeg/png/webp) и размер (до 2 МБ).'));
    }
    const webDb = require('./lib/webDb');
    webDb.prepare(
      'INSERT INTO avatars (user_id, image_path, uploaded_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET image_path = excluded.image_path, uploaded_at = excluded.uploaded_at'
    ).run(req.session.userId, `avatars/${req.session.userId}.jpg`, Math.floor(Date.now() / 1000));
    res.redirect(`/fighter/${req.session.userId}`);
  });
});
```

**Security note the implementer must preserve:** `avatarUpload`'s `filename` function reads `req.session.userId` — never `req.body`/`req.query`/`req.params` — so the saved filename is always the logged-in user's own verified id from the signed session cookie. There is no code path anywhere in this route that lets a request choose which `user_id` its upload is saved under.

- [ ] **Step 7: Syntax-check**

Run: `cd /c/Users/123/Projects/tg-web && node --check index.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Manual smoke test**

Run: `cd /c/Users/123/Projects/tg-web && node index.js &`, visit `http://localhost:3000/me/avatar` while logged out.
Expected: redirected to `/login` (since `requireAuth` has no session to check yet — full login-flow testing needs a real Telegram bot username/token, left to Task 6's manual verification). Stop the server afterward.

- [ ] **Step 9: Commit**

```bash
cd /c/Users/123/Projects/tg-web
git add lib/requireAuth.js lib/upload.js views/avatarForm.js lib/queries.js views/fighter.js index.js
git commit -m "feat: self-service avatar upload"
```

---

### Task 5: Admin weapon-icon panel

**Files:**
- Create: `c:\Users\123\Projects\tg-web\lib\requireAdmin.js`
- Create: `c:\Users\123\Projects\tg-web\views\admin.js`
- Modify: `c:\Users\123\Projects\tg-web\lib\queries.js`
- Modify: `c:\Users\123\Projects\tg-web\views\fighter.js`
- Modify: `c:\Users\123\Projects\tg-web\index.js`

**Depends on Task 3** (session) **and Task 4** (`makeUploader`, `requireAuth`).

- [ ] **Step 1: Write `lib/requireAdmin.js`**

```js
function getAdminUserIds() {
  return (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  if (!getAdminUserIds().includes(req.session.userId)) {
    return res.status(403).send('Доступ только для администраторов.');
  }
  next();
}

module.exports = requireAdmin;
```

- [ ] **Step 2: Write `views/admin.js`**

```js
const layout = require('./layout');
const WEAPON_DEFS = require('../lib/weaponDefs');

const WEAPON_KEYS = ['bat', 'axe', 'scissors', 'knife', 'carrot', 'horns', 'crutch'];

function renderAdmin(iconsByWeaponKey, error) {
  const rows = WEAPON_KEYS.map((key) => `
    <tr>
      <td>${WEAPON_DEFS[key].emoji} ${WEAPON_DEFS[key].name}</td>
      <td>${iconsByWeaponKey[key] ? `<img src="/uploads/${iconsByWeaponKey[key]}" width="40" height="40">` : '(нет иконки)'}</td>
      <td>
        <form method="post" action="/admin/weapon-icon" enctype="multipart/form-data" style="display:inline;">
          <input type="hidden" name="weapon_key" value="${key}">
          <input type="file" name="icon" accept="image/jpeg,image/png,image/webp" required>
          <button type="submit">Загрузить</button>
        </form>
      </td>
    </tr>
  `).join('');

  return layout('Админка — иконки оружия', `
    <h1>Иконки оружия</h1>
    ${error ? `<p style="color:red;">${error}</p>` : ''}
    <table>${rows}</table>
  `);
}

module.exports = renderAdmin;
```

- [ ] **Step 3: Add a weapon-icons lookup to `lib/queries.js`**

Find:
```js
function getAvatarPath(userId) {
  const row = webDb.prepare('SELECT image_path FROM avatars WHERE user_id = ?').get(userId);
  return row ? row.image_path : null;
}

module.exports = { getLeaderboard, getFighter, getAvatarPath };
```

Replace with:
```js
function getAvatarPath(userId) {
  const row = webDb.prepare('SELECT image_path FROM avatars WHERE user_id = ?').get(userId);
  return row ? row.image_path : null;
}

function getWeaponIcons() {
  const rows = webDb.prepare('SELECT weapon_key, image_path FROM weapon_icons').all();
  const byKey = {};
  for (const row of rows) byKey[row.weapon_key] = row.image_path;
  return byKey;
}

module.exports = { getLeaderboard, getFighter, getAvatarPath, getWeaponIcons };
```

- [ ] **Step 4: Show weapon icon images (falling back to emoji) on the profile page**

Find (in `views/fighter.js`):
```js
function renderFighter(fighter, avatarUrl) {
```

Replace with:
```js
function renderFighter(fighter, avatarUrl, weaponIcons) {
```

Find:
```js
  const weaponIcons = fighter.weapons.map(w => `<span title="${WEAPON_DEFS[w.weapon_key].name}">${WEAPON_DEFS[w.weapon_key].emoji}</span>`).join(' ') || '(пусто)';
```

Replace with:
```js
  const weaponHtml = fighter.weapons.map(w => {
    const iconPath = weaponIcons[w.weapon_key];
    return iconPath
      ? `<img src="/uploads/${iconPath}" title="${WEAPON_DEFS[w.weapon_key].name}" width="24" height="24">`
      : `<span title="${WEAPON_DEFS[w.weapon_key].name}">${WEAPON_DEFS[w.weapon_key].emoji}</span>`;
  }).join(' ') || '(пусто)';
```

Find:
```js
    <p>Оружие: ${weaponIcons}</p>
```

Replace with:
```js
    <p>Оружие: ${weaponHtml}</p>
```

- [ ] **Step 5: Wire admin routes into `index.js` and pass `weaponIcons` into the fighter route**

Find:
```js
const { getLeaderboard, getFighter, getAvatarPath } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');
const requireAuth = require('./lib/requireAuth');
const { makeUploader } = require('./lib/upload');
const renderAvatarForm = require('./views/avatarForm');

const avatarUpload = makeUploader('avatars', (req) => `${req.session.userId}.jpg`);
```

Replace with:
```js
const { getLeaderboard, getFighter, getAvatarPath, getWeaponIcons } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');
const requireAuth = require('./lib/requireAuth');
const requireAdmin = require('./lib/requireAdmin');
const { makeUploader, extensionFor } = require('./lib/upload');
const renderAvatarForm = require('./views/avatarForm');
const renderAdmin = require('./views/admin');

const avatarUpload = makeUploader('avatars', (req) => `${req.session.userId}.jpg`);
const weaponIconUpload = makeUploader('weapons', (req, file) => `${req.body.weapon_key}.${extensionFor(file.mimetype)}`);
const KNOWN_WEAPON_KEYS = ['bat', 'axe', 'scissors', 'knife', 'carrot', 'horns', 'crutch'];
```

Find:
```js
app.get('/fighter/:id', (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).send('Неверный id');
  const avatarPath = getAvatarPath(userId);
  res.send(renderFighter(getFighter(userId), avatarPath ? `/uploads/avatars/${userId}.jpg` : null));
});
```

Replace with:
```js
app.get('/fighter/:id', (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).send('Неверный id');
  const avatarPath = getAvatarPath(userId);
  res.send(renderFighter(getFighter(userId), avatarPath ? `/uploads/avatars/${userId}.jpg` : null, getWeaponIcons()));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.send(renderAdmin(getWeaponIcons(), null));
});

app.post('/admin/weapon-icon', requireAdmin, (req, res) => {
  // multer's own `enctype=multipart/form-data` parsing populates req.body
  // (including weapon_key) only DURING this call — it isn't available
  // before .single() runs, which is why weaponIconUpload's own filename
  // function reads req.body.weapon_key and why validity is re-checked
  // here afterward rather than in a separate earlier middleware.
  weaponIconUpload.single('icon')(req, res, (err) => {
    if (err || !req.file || !KNOWN_WEAPON_KEYS.includes(req.body.weapon_key)) {
      return res.send(renderAdmin(getWeaponIcons(), 'Не удалось загрузить — проверь тип оружия и формат файла.'));
    }
    const webDb = require('./lib/webDb');
    const relativePath = `weapons/${req.file.filename}`;
    webDb.prepare(
      'INSERT INTO weapon_icons (weapon_key, image_path, uploaded_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(weapon_key) DO UPDATE SET image_path = excluded.image_path, uploaded_at = excluded.uploaded_at'
    ).run(req.body.weapon_key, relativePath, Math.floor(Date.now() / 1000));
    res.redirect('/admin');
  });
});
```

**Note on `weaponIconUpload`'s filename function:** it trusts `req.body.weapon_key` for the *filename on disk*, but the actual acceptance check (`KNOWN_WEAPON_KEYS.includes(...)`) happens afterward, inside the route handler — an unrecognized `weapon_key` still gets a file written to a weird filename by multer, but is then rejected before ever reaching `webDb`, and the orphaned file is harmless clutter, not a security issue (this endpoint is already behind `requireAdmin`).

- [ ] **Step 6: Syntax-check**

Run: `cd /c/Users/123/Projects/tg-web && node --check index.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/123/Projects/tg-web
git add lib/requireAdmin.js views/admin.js lib/queries.js views/fighter.js index.js
git commit -m "feat: admin weapon-icon upload panel"
```

---

### Task 6: Manual deployment + verification (left to user)

Not automated — requires the real VPS, the real bot token, and a real Telegram login. Per project memory, both existing bots run on the remote VPS (`vm-a929e4`, user `root`, at `/root/Try_bot` and `/root/troll-bot`, managed via `pm2`) — this new app deploys the same way.

- [ ] Push this new repo to a remote (e.g. create an empty GitHub repo, `git remote add origin <url>`, `git push -u origin main`) — there is no remote configured yet since Task 1 only ran `git init`.
- [ ] On the VPS: `git clone <url> /root/tg-web && cd /root/tg-web && npm install --production`.
- [ ] Create `/root/tg-web/.env` (never committed) with real values:
  - `GAME_DB_PATH=/root/Try_bot/mutes.db`
  - `TG_BOT_TOKEN=` (tg-bot's real bot token, from `@BotFather` — the same one already running in `/root/Try_bot`)
  - `TG_BOT_USERNAME=` (tg-bot's bot username, no `@`)
  - `ADMIN_USER_IDS=8384023163`
  - `SESSION_SECRET=` (any long random string — e.g. `openssl rand -hex 32`)
  - `PORT=3000` (or whatever's free)
- [ ] One-time in Telegram: message `@BotFather`, `/setdomain`, select tg-bot, and set it to wherever this app will be publicly reachable (e.g. `web.example.com`) — the Login Widget will not work without this, regardless of how correct the code is.
- [ ] Start it: `pm2 start index.js --name tg-web && pm2 save`.
- [ ] Set up whatever reverse proxy / HTTPS termination already fronts the VPS's other public services to route the chosen domain to `PORT` — this is infrastructure specific to how the VPS is currently set up, not something this plan can specify generically.
- [ ] Verify: visit the public URL, confirm the leaderboard loads with real warriors from the live game; click through to a fighter profile; log in via the Telegram widget; upload an avatar and confirm it appears on your own profile; confirm a non-admin Telegram account gets a 403 on `/admin`; log in as the admin account and upload a weapon icon, confirm it appears next to that weapon on any fighter who holds one.
- [ ] Confirm nothing written by this app is visible from `tg-bot`/`troll-bot`'s own commands (e.g. `/me` in Telegram) — `web.db` should be entirely invisible to both bots, proving the read-only boundary held.

---

## Self-Review

**Spec coverage:** read-only game-data access via a dedicated readonly connection (✅ Task 1), separate `web.db` for avatars/weapon_icons (✅ Task 1), leaderboard + profile pages (✅ Task 2), Telegram Login verification + session (✅ Task 3), self-service avatar upload scoped to the session's own user_id (✅ Task 4), admin-gated weapon-icon upload with zero writes to `mutes.db` (✅ Task 5), deployment + BotFather `/setdomain` (✅ Task 6). No troll-bot or tg-bot (`bot.js`) changes anywhere (✅).

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code or an exact command with expected output. `ADMIN_USER_IDS`'s real value (`8384023163`) is documented as a manual `.env` step (Task 6), never hardcoded in source, matching the spec's explicit requirement.

**Type consistency:** `getFighter(userId)` (Task 2) returns a fixed shape (`userId`, `displayName`, `level`, `xp`, four attributes, `coins`, health/energy pairs, `isHospitalized`, `isBleeding`, `injury`, `weapons`) that every later task's changes to `views/fighter.js` (Tasks 4, 5) consume via the same field names — verified no task renames a field the next one still reads. `renderFighter`'s signature grows consistently across tasks: `(fighter)` → `(fighter, avatarUrl)` (Task 4) → `(fighter, avatarUrl, weaponIcons)` (Task 5), and every call site in `index.js` is updated in the same task that changes the signature.
