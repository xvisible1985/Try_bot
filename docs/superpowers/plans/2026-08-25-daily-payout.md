# Ежедневная выплата воинам Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every warrior gets +10 coins once a day at 08:00 server time, announced once in the arena chat.

**Architecture:** One new column on the existing `health_regen_state` singleton row, one new `if` block inside the existing `healthRegenTick` background job, reusing the exact "once per calendar day" idiom the 4am full-health-restore already uses right next to it.

**Tech Stack:** Node.js, `node-telegram-bot-api`, `better-sqlite3`, single file `bot.js`.

---

## Spec

Full design: `docs/superpowers/specs/2026-08-25-daily-payout-design.md`.

## Existing code this plan builds on (verified current line numbers)

- `health_regen_state` table + its singleton seed row — `bot.js:419-425`.
- The 4am full-restore check inside `healthRegenTick` — `bot.js:4002-4008` (uses `today`, `regenState`, `hour`, all already computed right there — the new 08:00 check reuses these same three variables, no new query).
- `ARENA_CHAT_ID` — already declared much earlier in the file (search `const ARENA_CHAT_ID`) — safe to reference here since `healthRegenTick` is a background job that only ever runs after the whole script has finished loading, well after every top-level `const` is initialized (unlike больничка's one-time migration, which had to worry about `runOnce`'s synchronous-at-load-time execution — this is not that situation).

---

### Task 1: Daily payout

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the `last_daily_payout_date` column**

Insert immediately after the `health_regen_state` seed-row insert (`bot.js:425`):

```js

// Daily warrior coin payout — see
// docs/superpowers/specs/2026-08-25-daily-payout-design.md. Same
// singleton-row idiom as last_full_restore_date above, just a second
// independent date guard on the same row.
for (const [column, def] of [['last_daily_payout_date', 'TEXT']]) {
  try { db.exec(`ALTER TABLE health_regen_state ADD COLUMN ${column} ${def}`); } catch {}
}
```

- [ ] **Step 2: Add the payout check in `healthRegenTick`**

Find (`bot.js:4002-4008`):

```js
    const today = new Date().toISOString().slice(0, 10);
    const regenState = db.prepare('SELECT last_full_restore_date FROM health_regen_state WHERE id = 1').get();
    const hour = new Date().getHours();
    if (hour === 4 && regenState.last_full_restore_date !== today) {
      db.prepare('UPDATE user_health SET health = max_health, last_regen_at = ?, hospitalized_since = NULL WHERE health < max_health').run(now);
      db.prepare('UPDATE health_regen_state SET last_full_restore_date = ? WHERE id = 1').run(today);
    }
```

Replace with:

```js
    const today = new Date().toISOString().slice(0, 10);
    const regenState = db.prepare('SELECT last_full_restore_date, last_daily_payout_date FROM health_regen_state WHERE id = 1').get();
    const hour = new Date().getHours();
    if (hour === 4 && regenState.last_full_restore_date !== today) {
      db.prepare('UPDATE user_health SET health = max_health, last_regen_at = ?, hospitalized_since = NULL WHERE health < max_health').run(now);
      db.prepare('UPDATE health_regen_state SET last_full_restore_date = ? WHERE id = 1').run(today);
    }
    if (hour === 8 && regenState.last_daily_payout_date !== today) {
      db.exec('UPDATE pvp_stats SET coins = coins + 10 WHERE is_warrior = 1');
      db.prepare('UPDATE health_regen_state SET last_daily_payout_date = ? WHERE id = 1').run(today);
      bot.sendMessage(ARENA_CHAT_ID, '💰 Всем воинам начислено +10 монет за день!').catch(err => console.error('daily payout announcement failed:', err.message));
    }
```

(Note the `SELECT` in the `regenState` query now also reads `last_daily_payout_date`, needed for the new check's own guard.)

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_dailypayout.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE health_regen_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_full_restore_date TEXT, last_daily_payout_date TEXT)`);
db.prepare('INSERT INTO health_regen_state (id, last_full_restore_date, last_daily_payout_date) VALUES (1, NULL, NULL)').run();
db.exec(`CREATE TABLE pvp_stats (user_id INTEGER PRIMARY KEY, is_warrior INTEGER NOT NULL DEFAULT 0, coins INTEGER NOT NULL DEFAULT 0)`);

db.prepare('INSERT INTO pvp_stats (user_id, is_warrior, coins) VALUES (1, 1, 5)').run();
db.prepare('INSERT INTO pvp_stats (user_id, is_warrior, coins) VALUES (2, 0, 0)').run(); // not a warrior

let announcements = 0;
function tick(today, hour) {
  const regenState = db.prepare('SELECT last_full_restore_date, last_daily_payout_date FROM health_regen_state WHERE id = 1').get();
  if (hour === 8 && regenState.last_daily_payout_date !== today) {
    db.exec('UPDATE pvp_stats SET coins = coins + 10 WHERE is_warrior = 1');
    db.prepare('UPDATE health_regen_state SET last_daily_payout_date = ? WHERE id = 1').run(today);
    announcements++;
  }
}

tick('2026-08-25', 7);
console.log('no payout before 8am:', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=1').get(), 'expected {coins: 5}');
console.log('announcements so far:', announcements, 'expected 0');

tick('2026-08-25', 8);
console.log('warrior paid at 8am:', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=1').get(), 'expected {coins: 15}');
console.log('non-warrior untouched:', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=2').get(), 'expected {coins: 0}');
console.log('announcements so far:', announcements, 'expected 1');

tick('2026-08-25', 8); // same day, still hour 8 -> must not re-fire
console.log('no double payout same day:', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=1').get(), 'expected {coins: 15}');
console.log('announcements still:', announcements, 'expected 1');

tick('2026-08-26', 8); // next day -> fires again
console.log('payout fires again next day:', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=1').get(), 'expected {coins: 25}');
console.log('announcements now:', announcements, 'expected 2');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_dailypayout.js`

Expected output (must match exactly):
```
no payout before 8am: { coins: 5 } expected {coins: 5}
announcements so far: 0 expected 0
warrior paid at 8am: { coins: 15 } expected {coins: 15}
non-warrior untouched: { coins: 0 } expected {coins: 0}
announcements so far: 1 expected 1
no double payout same day: { coins: 15 } expected {coins: 15}
announcements still: 1 expected 1
payout fires again next day: { coins: 25 } expected {coins: 25}
announcements now: 2 expected 2
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_dailypayout.js`

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: daily +10 coin payout to all warriors at 08:00"
```

Then push (this repo commits straight to main, no worktree, pushes immediately per standing project convention).

---

### Task 2: Manual verification (left to user)

- [ ] After deploy, confirm at the next 08:00 server time that every warrior's `/wallet` balance goes up by exactly 10, and the "💰 Всем воинам начислено +10 монет за день!" message appears exactly once in "Поединки".
- [ ] Confirm no second payout the same day even if the bot restarts during the 08:00 hour.
- [ ] Confirm a non-warrior's coins (if they somehow have a `pvp_stats` row) stay untouched.

---

## Self-Review

**Spec coverage:** schema (✅), trigger + announcement (✅). Nothing else in scope for this spec.

**Placeholder scan:** none.

**Type consistency:** `last_daily_payout_date` follows the exact same `'YYYY-MM-DD' string, compared via !==` idiom as the pre-existing `last_full_restore_date` — no new date-handling pattern introduced.
