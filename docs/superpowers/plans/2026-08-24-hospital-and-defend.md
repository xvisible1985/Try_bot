# Больничка + Защитная стойка Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 30-minute knockout mute with больничка (a health-gated recovery state, until 30 HP, ×2 regen, blocks being targeted, attacking ejects you early), and add `/defend` (a voluntary 30-min self-buff: +25 dodge threshold, −40% incoming graduated damage, attacking ends it).

**Architecture:** Both features live entirely in `c:\Users\123\Projects\tg-bot\bot.js`. Больничка adds one nullable column to the existing `user_health` table and one lazy-check helper (`isHospitalized`), following the exact same idiom as the existing `isHidden`/чулан mechanic. `/defend` adds one nullable column to the existing `buffs` table (same table `kuniFun`/`kuniAlia`/`kuniTama` already use) and one lazy-check helper (`isDefending`). Both integrate into `performKick` at the same three points чулан already uses: a target-side block, an attacker-side "auto-break on attack," and (для defend) direct terms in the existing opposed-roll/damage-calc formulas.

**Tech Stack:** Node.js, `node-telegram-bot-api`, `better-sqlite3`, single file `bot.js`.

---

## Spec

Full design: `docs/superpowers/specs/2026-08-24-hospital-and-defend-design.md`. Read it before starting — this plan implements it directly, with a few small, explicitly-noted deviations for consistency with the current codebase (called out inline below).

## Existing code this plan builds on (verified current line numbers — re-locate by searching for the quoted surrounding text if these have drifted, per this project's established practice)

- `user_health` ALTER-column idiom — `bot.js:364-382` (energy columns, then bleed columns, each its own `for (const [column, def] of [...])` block).
- Combat constants block — `bot.js:1140-1155` (`ACCURACY_PER_POINT` through `XP_PER_NAT100`).
- `buffs` table — `bot.js:411-422`.
- `isKnockedOut(userId)` — `bot.js:883-900` (deleted in Task 2).
- `muteUser(userId, chatId, username, byId, byName, durationMs)` — `bot.js:910` — stays; still used by the real `/mute` admin command (`bot.js:1110`). Only its ONE call from `damageHuman` (knockout) is removed.
- `isHidden(userId)` — `bot.js:1299-1305`.
- `damageHuman(userId, chatId, username, damage)` — `bot.js:1316-1324`.
- `/me` command — `bot.js:1451-1517`.
- `/find` command — `bot.js:1581-1604`.
- `async function performKick(chatId, msgLike, attacker, target, slot)` — `bot.js:1922` onward. Key sub-regions used below:
  - Target-side pre-checks (`isHidden(target.id)`) — `bot.js:1942-1945`.
  - Attacker-side hard-blocks (`isKnockedOut(attacker.id)`) — `bot.js:1948-1951` (deleted in Task 2).
  - Attacker-side auto-break (`isHidden(attacker.id)`, right before `consumeEnergy(attacker.id)`) — `bot.js:1989-1993`.
  - Opposed-roll `defenderScore` calc — `bot.js:2013-2022`.
  - `strengthFactor`/`armInjuryFactor` — `bot.js:2058-2059`.
  - Graduated-damage sites: carrot `ear` (`bot.js:2084`), carrot `nose` (`bot.js:2088`), generic non-carrot weapon branch (`bot.js:2117`). **Not** graduated (exact-value effects, already excluded from `strengthFactor`/`armInjuryFactor` and, per this plan, also excluded from the new `defendFactor` for the same reason): `roll === 100` (`bot.js:2072`), carrot `mouth`/`dick` (heals, not damage — `bot.js:2092`, `2097`), carrot `ass` (`bot.js:2111`), axe's flat extra `-10` (`bot.js:2165`, its own comment already says "not scaled by strength/injury, same guaranteed bonus effect idiom as carrot's dick heal" — `defendFactor` follows that same precedent).
- `bot.onText(/\/kuniFun\b/` — `bot.js:2276` — `/defend` goes near this neighborhood (same category: public self-buff command).
- `HEALTH_REGEN_PER_HOUR` — `bot.js:3655` (currently `10`).
- `function healthRegenTick()` — `bot.js:3663`, per-user regen loop at `bot.js:3667-3674`.
- `bot.onText(/\/helppvp\b/` — `bot.js:3279-3298` (this repo's `/help` was just split into per-section commands; PvP content lives here now, not in the old single `/help` handler).

No new tables. No troll-bot changes — troll-bot's own `isKnockedOut()` copy (reading the shared `mutes` table) is explicitly left untouched; it will simply stop ever seeing a `'драка'` mute once `damageHuman` stops writing one. This is confirmed, intentional, out of scope for this plan.

**Do not touch `bleedTick` or `arenaTick`** (both existing background timers, unrelated to this plan) — there's a separate, already-diagnosed bug in those two (missing `message_thread_id`) being fixed independently.

---

### Task 1: Больничка — schema, constants, `isHospitalized`, `damageHuman`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the `hospitalized_since` column**

Insert immediately after the existing bleed-columns `for` block (search for `last_bleed_stop_attempt_at`, the block ends at `bot.js:382`):

```js
// Больничка — automatic recovery state entered on knockout (see
// docs/superpowers/specs/2026-08-24-hospital-and-defend-design.md).
// NULL when not hospitalized; a unix timestamp (seconds) marking entry
// otherwise. Combined with health < HOSPITAL_EXIT_HEALTH (see
// isHospitalized below) to decide "still hospitalized" — there is no
// separate boolean column. Same ALTER idiom as energy/bleed above.
for (const [column, def] of [['hospitalized_since', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
  } catch {}
}
```

- [ ] **Step 2: Add the больничка constants**

Insert immediately after `const XP_PER_NAT100 = 15;` (`bot.js:1155`):

```js
const HOSPITAL_EXIT_HEALTH = 30;      // больничка releases you once health reaches this
const HOSPITAL_REGEN_MULTIPLIER = 2;  // regen rate while hospitalized, vs. the normal HEALTH_REGEN_PER_HOUR baseline
```

- [ ] **Step 3: Add `isHospitalized`**

Insert immediately after `isHidden`'s closing `}` (`bot.js:1305`), before the blank line that precedes `damageHuman`'s doc comment:

```js

// Больничка protection — lazily read, same check-and-clear idiom as
// isHidden. A player counts as hospitalized only while BOTH a non-NULL
// hospitalized_since exists AND health is still under the exit
// threshold; the moment either healthRegenTick or a direct read finds
// health >= HOSPITAL_EXIT_HEALTH, the flag self-clears right here.
function isHospitalized(userId) {
  const row = db.prepare('SELECT hospitalized_since, health FROM user_health WHERE user_id = ?').get(userId);
  if (!row || row.hospitalized_since === null) return false;
  if (row.health < HOSPITAL_EXIT_HEALTH) return true;
  db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(userId);
  return false;
}
```

- [ ] **Step 4: Replace `damageHuman`'s knockout mute with больничка entry**

Find (`bot.js:1316-1324`):

```js
function damageHuman(userId, chatId, username, damage) {
  getUserHealth(userId);
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('UPDATE user_health SET health = MAX(0, health - ?), last_regen_at = ? WHERE user_id = ? RETURNING health').get(damage, now, userId);
  if (row.health === 0) {
    muteUser(userId, chatId, username, 0, 'драка', 30 * 60 * 1000);
  }
  return row.health;
}
```

Replace with:

```js
function damageHuman(userId, chatId, username, damage) {
  getUserHealth(userId);
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('UPDATE user_health SET health = MAX(0, health - ?), last_regen_at = ? WHERE user_id = ? RETURNING health').get(damage, now, userId);
  if (row.health === 0) {
    // COALESCE: re-flooring an already-hospitalized player to 0 again
    // (e.g. a second hit landing before they've regenerated at all)
    // must not reset their entry timestamp.
    db.prepare('UPDATE user_health SET hospitalized_since = COALESCE(hospitalized_since, ?) WHERE user_id = ?').run(now, userId);
  }
  return row.health;
}
```

**Note:** `chatId` and `username` become unused inside `damageHuman` after this change (their only use was the deleted `muteUser` call). Leave the function signature and every call site unchanged — `damageHuman` is called from many places throughout `bot.js` with these positional args; stripping the now-unused params would be an unrelated, unnecessary refactor across all of them for no functional benefit. Do not touch `muteUser` itself — it's still used by the real `/mute` admin command.

- [ ] **Step 5: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_hospital1.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, hospitalized_since INTEGER)`);

const HOSPITAL_EXIT_HEALTH = 30;

function isHospitalized(userId) {
  const row = db.prepare('SELECT hospitalized_since, health FROM user_health WHERE user_id = ?').get(userId);
  if (!row || row.hospitalized_since === null) return false;
  if (row.health < HOSPITAL_EXIT_HEALTH) return true;
  db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(userId);
  return false;
}

db.prepare('INSERT INTO user_health (user_id, health, hospitalized_since) VALUES (1, 0, 1000)').run();
console.log('hospitalized at 0 HP:', isHospitalized(1), 'expected true');

db.prepare('UPDATE user_health SET health = 29 WHERE user_id = 1').run();
console.log('hospitalized at 29 HP:', isHospitalized(1), 'expected true');

db.prepare('UPDATE user_health SET health = 30 WHERE user_id = 1').run();
console.log('hospitalized at 30 HP (self-clears):', isHospitalized(1), 'expected false');
console.log('hospitalized_since after self-clear:', db.prepare('SELECT hospitalized_since FROM user_health WHERE user_id = 1').get(), 'expected {hospitalized_since: null}');

db.prepare('INSERT INTO user_health (user_id, health, hospitalized_since) VALUES (2, 100, NULL)').run();
console.log('never hospitalized, full health:', isHospitalized(2), 'expected false');

function enterHospitalIfKnockedOut(userId, now) {
  db.prepare('UPDATE user_health SET hospitalized_since = COALESCE(hospitalized_since, ?) WHERE user_id = ?').run(now, userId);
}
db.prepare('INSERT INTO user_health (user_id, health, hospitalized_since) VALUES (3, 0, 500)').run();
enterHospitalIfKnockedOut(3, 9999);
console.log('re-knockout does not reset entry time:', db.prepare('SELECT hospitalized_since FROM user_health WHERE user_id = 3').get(), 'expected {hospitalized_since: 500}');

db.prepare('INSERT INTO user_health (user_id, health, hospitalized_since) VALUES (4, 0, NULL)').run();
enterHospitalIfKnockedOut(4, 12345);
console.log('fresh knockout sets entry time:', db.prepare('SELECT hospitalized_since FROM user_health WHERE user_id = 4').get(), 'expected {hospitalized_since: 12345}');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_hospital1.js`

Expected output (must match exactly):
```
hospitalized at 0 HP: true expected true
hospitalized at 29 HP: true expected true
hospitalized at 30 HP (self-clears): false expected false
hospitalized_since after self-clear: { hospitalized_since: null } expected {hospitalized_since: null}
never hospitalized, full health: false expected false
re-knockout does not reset entry time: { hospitalized_since: 500 } expected {hospitalized_since: 500}
fresh knockout sets entry time: { hospitalized_since: 12345 } expected {hospitalized_since: 12345}
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_hospital1.js`

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat: add больничка schema, isHospitalized, damageHuman entry"
```

---

### Task 2: Больничка — `performKick` integration, regen rate

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Delete `isKnockedOut` entirely**

Find and delete (`bot.js:883-900`, including its doc comment):

```js
// Whether an attacker is still within their post-knockout mute (see
// damageHuman's muteUser(..., 'драка', 30 min) call below). /kick used
// to gate on health === 0 directly, but healthRegenTick's hourly
// trickle can bring health back above 0 within as little as 10 minutes
// — well before the intended 30-minute "в отключке" window ends —
// which let a just-regenerated attacker swing again with no warning.
// Checking the mute row (by reason, not by admin mutes in general) is
// the actual source of truth for "still down from a fight" regardless
// of how far health has already regenerated.
function isKnockedOut(userId) {
  const row = db.prepare('SELECT muted_by_name, expires_at FROM mutes WHERE user_id = ?').get(userId);
  if (!row || row.muted_by_name !== 'драка') return false;
  if (row.expires_at && row.expires_at * 1000 < Date.now()) {
    db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
    return false;
  }
  return true;
}

```

(Leave the blank line structure around it sane — deleting the whole block including its trailing blank line, then the following comment `// Bat's 30%-on-hit stun...` continues right after where this block was.)

- [ ] **Step 2: Add больничка's target-side block in `performKick`**

Find (`bot.js:1942-1947`):

```js
  if (isHidden(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} прячется в чулане — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  const attackerHealth = getUserHealth(attacker.id);
  if (isKnockedOut(attacker.id)) {
    bot.sendMessage(chatId, `${actorLabel}, твоя в отключке, какая драка!`, threadOpts(msgLike)).catch(() => {});
    return;
  }
```

Replace with:

```js
  if (isHidden(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} прячется в чулане — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isHospitalized(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} лежит в больничке — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  const attackerHealth = getUserHealth(attacker.id);
```

(This deletes the old attacker-side `isKnockedOut` hard-block entirely — replaced by больничка's own attacker-side auto-break in the next step, which allows the attack but ejects the attacker from больничка first, per the spec.)

- [ ] **Step 3: Add больничка's attacker-side auto-break**

Find (`bot.js:1989-1993`):

```js
  if (isHidden(attacker.id)) {
    endHideSession(attacker.id, Math.floor(Date.now() / 1000));
    await bot.sendMessage(chatId, `🚪 ${actorLabel} выскакивает из чулана, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  consumeEnergy(attacker.id);
```

Replace with:

```js
  if (isHidden(attacker.id)) {
    endHideSession(attacker.id, Math.floor(Date.now() / 1000));
    await bot.sendMessage(chatId, `🚪 ${actorLabel} выскакивает из чулана, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  if (isHospitalized(attacker.id)) {
    db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(attacker.id);
    await bot.sendMessage(chatId, `🏥 ${actorLabel} выписывается из больнички, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  consumeEnergy(attacker.id);
```

- [ ] **Step 4: Bump the regen baseline**

Find (`bot.js:3655`): `const HEALTH_REGEN_PER_HOUR = 10;`
Replace with: `const HEALTH_REGEN_PER_HOUR = 20;`

- [ ] **Step 5: Make `healthRegenTick` больничка-aware**

Find (`bot.js:3667-3674`):

```js
    const rows = db.prepare('SELECT user_id, health, max_health, last_regen_at FROM user_health WHERE health < max_health').all();
    for (const row of rows) {
      const elapsedSeconds = row.last_regen_at ? now - row.last_regen_at : 3600;
      const gain = Math.floor((elapsedSeconds / 3600) * HEALTH_REGEN_PER_HOUR);
      if (gain > 0) {
        db.prepare('UPDATE user_health SET health = MIN(max_health, health + ?), last_regen_at = ? WHERE user_id = ?').run(gain, now, row.user_id);
      }
    }
```

Replace with:

```js
    const rows = db.prepare('SELECT user_id, health, max_health, last_regen_at, hospitalized_since FROM user_health WHERE health < max_health').all();
    for (const row of rows) {
      const elapsedSeconds = row.last_regen_at ? now - row.last_regen_at : 3600;
      const rate = row.hospitalized_since !== null ? HEALTH_REGEN_PER_HOUR * HOSPITAL_REGEN_MULTIPLIER : HEALTH_REGEN_PER_HOUR;
      const gain = Math.floor((elapsedSeconds / 3600) * rate);
      if (gain > 0) {
        const newHealth = Math.min(row.max_health, row.health + gain);
        const stillHospitalized = row.hospitalized_since !== null && newHealth < HOSPITAL_EXIT_HEALTH;
        db.prepare(
          'UPDATE user_health SET health = ?, last_regen_at = ?, hospitalized_since = ? WHERE user_id = ?'
        ).run(newHealth, now, stillHospitalized ? row.hospitalized_since : null, row.user_id);
      }
    }
```

- [ ] **Step 6: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_hospital2.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER, max_health INTEGER, last_regen_at INTEGER, hospitalized_since INTEGER)`);

const HEALTH_REGEN_PER_HOUR = 20;
const HOSPITAL_REGEN_MULTIPLIER = 2;
const HOSPITAL_EXIT_HEALTH = 30;

function tickOnce(now) {
  const rows = db.prepare('SELECT user_id, health, max_health, last_regen_at, hospitalized_since FROM user_health WHERE health < max_health').all();
  for (const row of rows) {
    const elapsedSeconds = row.last_regen_at ? now - row.last_regen_at : 3600;
    const rate = row.hospitalized_since !== null ? HEALTH_REGEN_PER_HOUR * HOSPITAL_REGEN_MULTIPLIER : HEALTH_REGEN_PER_HOUR;
    const gain = Math.floor((elapsedSeconds / 3600) * rate);
    if (gain > 0) {
      const newHealth = Math.min(row.max_health, row.health + gain);
      const stillHospitalized = row.hospitalized_since !== null && newHealth < HOSPITAL_EXIT_HEALTH;
      db.prepare('UPDATE user_health SET health = ?, last_regen_at = ?, hospitalized_since = ? WHERE user_id = ?').run(newHealth, now, stillHospitalized ? row.hospitalized_since : null, row.user_id);
    }
  }
}

db.prepare('INSERT INTO user_health (user_id, health, max_health, last_regen_at, hospitalized_since) VALUES (1, 50, 100, 0, NULL)').run();
tickOnce(3600);
console.log('non-hospitalized 1h regen (base rate):', db.prepare('SELECT health FROM user_health WHERE user_id=1').get(), 'expected {health: 70}');

db.prepare('INSERT INTO user_health (user_id, health, max_health, last_regen_at, hospitalized_since) VALUES (2, 0, 100, 0, 0)').run();
tickOnce(3600);
console.log('hospitalized 1h regen crosses 30, self-clears:', db.prepare('SELECT health, hospitalized_since FROM user_health WHERE user_id=2').get(), 'expected {health: 40, hospitalized_since: null}');

db.prepare('INSERT INTO user_health (user_id, health, max_health, last_regen_at, hospitalized_since) VALUES (3, 0, 100, 0, 0)').run();
tickOnce(1800);
console.log('hospitalized partial tick stays under 30:', db.prepare('SELECT health, hospitalized_since FROM user_health WHERE user_id=3').get(), 'expected {health: 20, hospitalized_since: 0}');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_hospital2.js`

Expected output (must match exactly):
```
non-hospitalized 1h regen (base rate): { health: 70 } expected {health: 70}
hospitalized 1h regen crosses 30, self-clears: { health: 40, hospitalized_since: null } expected {health: 40, hospitalized_since: null}
hospitalized partial tick stays under 30: { health: 20, hospitalized_since: 0 } expected {health: 20, hospitalized_since: 0}
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_hospital2.js`

- [ ] **Step 8: Commit**

```bash
git add bot.js
git commit -m "feat: больничка performKick integration, x2 regen baseline bump"
```

---

### Task 3: Больничка — `/me`, `/find`, `/helppvp` text

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: `/me` больничка line**

Find (`bot.js:1486-1490`):

```js
  const hidden = isHidden(msg.from.id);
  const hideRow = db.prepare('SELECT hidden_until, hidden_since FROM user_health WHERE user_id = ?').get(msg.from.id);
  if (hidden) {
    lines.push(`🐰 Прячешься в чулане (осталось ${formatExpire(hideRow.hidden_until)})`);
  }
```

Replace with:

```js
  if (isHospitalized(msg.from.id)) {
    lines.push(`🏥 В больничке (здоровье ${health.health}/${HOSPITAL_EXIT_HEALTH})`);
  }

  const hidden = isHidden(msg.from.id);
  const hideRow = db.prepare('SELECT hidden_until, hidden_since FROM user_health WHERE user_id = ?').get(msg.from.id);
  if (hidden) {
    lines.push(`🐰 Прячешься в чулане (осталось ${formatExpire(hideRow.hidden_until)})`);
  }
```

(`health` is already in scope from `/me`'s first line, `const health = getUserHealth(msg.from.id);` — reuses it instead of a redundant extra query.)

- [ ] **Step 2: `/find` больничка bucket**

Find (`bot.js:1590-1602`):

```js
  const hiddenLines = [];
  const visibleLines = [];
  for (const { user_id } of fighters) {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(user_id);
    const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${user_id}`;
    if (isHidden(user_id)) {
      const row = db.prepare('SELECT hidden_until FROM user_health WHERE user_id = ?').get(user_id);
      hiddenLines.push(`🐰 ${label} (ещё ${formatExpire(row.hidden_until)})`);
    } else {
      visibleLines.push(`⚔️ ${label}`);
    }
  }
  const lines = ['Бойцы:', ...hiddenLines, ...visibleLines];
```

Replace with:

```js
  const hospitalLines = [];
  const hiddenLines = [];
  const visibleLines = [];
  for (const { user_id } of fighters) {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(user_id);
    const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${user_id}`;
    if (isHospitalized(user_id)) {
      const row = db.prepare('SELECT health FROM user_health WHERE user_id = ?').get(user_id);
      hospitalLines.push(`🏥 ${label} (${row.health}/${HOSPITAL_EXIT_HEALTH} ХП)`);
    } else if (isHidden(user_id)) {
      const row = db.prepare('SELECT hidden_until FROM user_health WHERE user_id = ?').get(user_id);
      hiddenLines.push(`🐰 ${label} (ещё ${formatExpire(row.hidden_until)})`);
    } else {
      visibleLines.push(`⚔️ ${label}`);
    }
  }
  const lines = ['Бойцы:', ...hospitalLines, ...hiddenLines, ...visibleLines];
```

- [ ] **Step 3: `/helppvp` — update `/kick`'s knockout description**

Find this exact substring inside the long `/kick` help line (`bot.js:3290`):

```
нога -10% уворота у пострадавшего — не блокирует атаку), 0 здоровья — мут на 30 мин + если у жертвы было оружие
```

Replace with:

```
нога -10% уворота у пострадавшего — не блокирует атаку), 0 здоровья — попадает в больничку (недоступен для удара, регенерация ×2, пока не наберёт 30 ХП; может выйти раньше сам, атаковав) + если у жертвы было оружие
```

- [ ] **Step 4: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: больничка status in /me, /find, /helppvp"
```

---

### Task 4: Защитная стойка — schema, constants, `isDefending`, `/defend`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the `defend_until` column**

Insert immediately after the `buffs` table's `CREATE TABLE` statement (`bot.js:422`, right after the closing `` `); ``):

```js

// Защитная стойка — /defend below. Same ALTER-after-CREATE idiom as
// every other column added to an existing table in this project.
for (const [column, def] of [['defend_until', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE buffs ADD COLUMN ${column} ${def}`);
  } catch {}
}
```

- [ ] **Step 2: Add the defend constants**

Insert immediately after `const HOSPITAL_REGEN_MULTIPLIER = 2;` (added in Task 1, now at `bot.js:1157`):

```js
const DEFEND_DURATION_MS = 30 * 60 * 1000;
const DEFEND_ENERGY_COST = 2;
const DEFEND_DODGE_BONUS = 25;      // added to the defender's opposed-roll score, on top of everything else
const DEFEND_DAMAGE_REDUCTION = 0.4; // incoming graduated damage ×(1 - 0.4); does NOT apply to nat-100/carrot-ass/axe-shave
```

- [ ] **Step 3: Add `isDefending`**

Insert right after `isHospitalized`'s closing `}` (added in Task 1):

```js

// Защитная стойка — pure lazy read, no clearing needed here (same idiom
// as getHitThreshold/getCritThreshold reading their own *_until columns
// — expiry is just a timestamp comparison, nothing to finalize).
function isDefending(userId) {
  const row = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(userId);
  return !!row && row.defend_until > Math.floor(Date.now() / 1000);
}
```

- [ ] **Step 4: Add the `/defend` command**

Insert immediately before `bot.onText(/\/kuniFun\b/` (`bot.js:2276`):

```js
// /defend — voluntary 30-min self-buff trading offense for defense (see
// docs/superpowers/specs/2026-08-24-hospital-and-defend-design.md).
// Always succeeds once energy is paid (unlike the kuni buffs' 50/50 —
// this is "assume a stance," not an attempt that can fail). Cooldown is
// the stance's own duration, same pattern as kuniFun/kuniAlia/kuniTama.
bot.onText(/\/defend\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.defend_until > now) {
    const minutesLeft = Math.ceil((row.defend_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, стойка уже активна (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  if (consumeEnergy(msg.from.id, DEFEND_ENERGY_COST) === null) {
    const current = getUserHealth(msg.from.id).energy;
    return bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии на стойку (нужно ${DEFEND_ENERGY_COST}, есть ${current}).`, threadOpts(msg));
  }
  const until = now + DEFEND_DURATION_MS / 1000;
  db.prepare(
    'INSERT INTO buffs (user_id, defend_until) VALUES (?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET defend_until = excluded.defend_until'
  ).run(msg.from.id, until);
  bot.sendMessage(msg.chat.id, `🛡️ ${actorLabel} встаёт в защитную стойку на 30 мин: +${DEFEND_DODGE_BONUS} к увороту, −${Math.round(DEFEND_DAMAGE_REDUCTION * 100)}% входящего урона. Атака снимет стойку.`, threadOpts(msg)).catch(() => {});
});

```

- [ ] **Step 5: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_defend1.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE buffs (user_id INTEGER PRIMARY KEY, defend_until INTEGER)`);

function isDefending(userId) {
  const row = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(userId);
  return !!row && row.defend_until > Math.floor(Date.now() / 1000);
}

const now = Math.floor(Date.now() / 1000);
db.prepare('INSERT INTO buffs (user_id, defend_until) VALUES (1, ?)').run(now + 600);
console.log('active defend:', isDefending(1), 'expected true');

db.prepare('INSERT INTO buffs (user_id, defend_until) VALUES (2, ?)').run(now - 10);
console.log('expired defend:', isDefending(2), 'expected false');

console.log('no row at all:', isDefending(3), 'expected false');

db.prepare('INSERT INTO buffs (user_id, defend_until) VALUES (4, NULL)').run();
console.log('row exists but defend_until NULL:', isDefending(4), 'expected false');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_defend1.js`

Expected output (must match exactly):
```
active defend: true expected true
expired defend: false expected false
no row at all: false expected false
row exists but defend_until NULL: false expected false
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_defend1.js`

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat: add /defend command, isDefending, buffs.defend_until"
```

---

### Task 5: Защитная стойка — `performKick` integration

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add `defendDodgeBonus` to the opposed-roll `defenderScore`**

Find (`bot.js:2013-2022`):

```js
  } else {
    attackerScore = roll + attackerStats.accuracy * ACCURACY_PER_POINT - (attackerInjury === 'head' ? HEAD_INJURY_ACCURACY_PENALTY : 0);
    const targetInjury = getUserInjury(target.id);
    const targetStats = getStats(target.id);
    const dodgeBuffBonus = getHitThreshold(target.id) - 50; // active kuni dodge buff, mapped onto this scale
    const defenderRoll = Math.floor(Math.random() * 101);
    defenderScore = defenderRoll + dodgeBuffBonus + targetStats.agility * AGILITY_DODGE_PER_POINT - (targetInjury === 'leg' ? LEG_INJURY_DODGE_PENALTY : 0);
    success = attackerScore > defenderScore;
    dodgedByDefender = !success;
  }
```

Replace with:

```js
  } else {
    attackerScore = roll + attackerStats.accuracy * ACCURACY_PER_POINT - (attackerInjury === 'head' ? HEAD_INJURY_ACCURACY_PENALTY : 0);
    const targetInjury = getUserInjury(target.id);
    const targetStats = getStats(target.id);
    const dodgeBuffBonus = getHitThreshold(target.id) - 50; // active kuni dodge buff, mapped onto this scale
    const defendDodgeBonus = isDefending(target.id) ? DEFEND_DODGE_BONUS : 0;
    const defenderRoll = Math.floor(Math.random() * 101);
    defenderScore = defenderRoll + dodgeBuffBonus + defendDodgeBonus + targetStats.agility * AGILITY_DODGE_PER_POINT - (targetInjury === 'leg' ? LEG_INJURY_DODGE_PENALTY : 0);
    success = attackerScore > defenderScore;
    dodgedByDefender = !success;
  }
```

- [ ] **Step 2: Add `defendFactor` and apply it at every graduated-damage site**

Find (`bot.js:2058-2059`):

```js
  const strengthFactor = 1 + attackerStats.strength * STRENGTH_DAMAGE_PER_POINT;
  const armInjuryFactor = attackerInjury === 'arm' ? ARM_INJURY_DAMAGE_MULT : 1;
```

Replace with:

```js
  const strengthFactor = 1 + attackerStats.strength * STRENGTH_DAMAGE_PER_POINT;
  const armInjuryFactor = attackerInjury === 'arm' ? ARM_INJURY_DAMAGE_MULT : 1;
  // Excluded from nat-100, carrot "ass", carrot "dick"/"mouth" (heals,
  // not damage), and axe's flat extra -10 — same "exact-value effect,
  // not scaled by anything" precedent strengthFactor/armInjuryFactor
  // already follow for those same sites.
  const defendFactor = isDefending(target.id) ? (1 - DEFEND_DAMAGE_REDUCTION) : 1;
```

Find (`bot.js:2084`, inside `hole === 'ear'`):

```js
      const dmg = Math.round(rawDmg * 0.8 * strengthFactor * armInjuryFactor);
```

Replace with:

```js
      const dmg = Math.round(rawDmg * 0.8 * strengthFactor * armInjuryFactor * defendFactor);
```

Find (`bot.js:2088`, inside `hole === 'nose'`):

```js
      const dmg = Math.round(rawDmg * 0.9 * strengthFactor * armInjuryFactor);
```

Replace with:

```js
      const dmg = Math.round(rawDmg * 0.9 * strengthFactor * armInjuryFactor * defendFactor);
```

Find (`bot.js:2116-2117`, the generic non-carrot weapon branch):

```js
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const dmg = Math.round(rawDmg * weapon.multiplier * strengthFactor * armInjuryFactor);
```

Replace with:

```js
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const dmg = Math.round(rawDmg * weapon.multiplier * strengthFactor * armInjuryFactor * defendFactor);
```

**Do not** touch: the `roll === 100` branch (`bot.js:2072`), carrot `mouth`/`dick` (`bot.js:2092`, `2097` — heals), carrot `ass` (`bot.js:2111`), or axe's flat `-10` (`bot.js:2165`). None of these multiply by `defendFactor`.

- [ ] **Step 3: Add defend's attacker-side auto-break**

Find (this is больничка's auto-break block from Task 2, now at roughly `bot.js:1989-1997` — re-locate by searching for the больничка/чулан auto-break neighborhood, since Task 2's edits shifted line numbers):

```js
  if (isHidden(attacker.id)) {
    endHideSession(attacker.id, Math.floor(Date.now() / 1000));
    await bot.sendMessage(chatId, `🚪 ${actorLabel} выскакивает из чулана, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  if (isHospitalized(attacker.id)) {
    db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(attacker.id);
    await bot.sendMessage(chatId, `🏥 ${actorLabel} выписывается из больнички, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  consumeEnergy(attacker.id);
```

Replace with:

```js
  if (isHidden(attacker.id)) {
    endHideSession(attacker.id, Math.floor(Date.now() / 1000));
    await bot.sendMessage(chatId, `🚪 ${actorLabel} выскакивает из чулана, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  if (isHospitalized(attacker.id)) {
    db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(attacker.id);
    await bot.sendMessage(chatId, `🏥 ${actorLabel} выписывается из больнички, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  if (isDefending(attacker.id)) {
    db.prepare('UPDATE buffs SET defend_until = NULL WHERE user_id = ?').run(attacker.id);
    await bot.sendMessage(chatId, `🛡️ ${actorLabel} опускает защиту, чтобы атаковать!`, threadOpts(msgLike)).catch(() => {});
  }
  consumeEnergy(attacker.id);
```

- [ ] **Step 4: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Write and run the isolated verification script**

This covers the pure arithmetic. The structural exclusion (nat-100/carrot-ass/axe-shave never multiplying by `defendFactor`) is enforced by *where* the multiplication was inserted in Step 2, not by anything an isolated script can assert — the code reviewer verifies that positionally against the diff.

Create `c:\Users\123\Projects\tg-bot\_verify_defend2.js`:

```js
const DEFEND_DODGE_BONUS = 25;
const DEFEND_DAMAGE_REDUCTION = 0.4;

function defendFactorFor(isDefendingFlag) {
  return isDefendingFlag ? (1 - DEFEND_DAMAGE_REDUCTION) : 1;
}
function defendDodgeBonusFor(isDefendingFlag) {
  return isDefendingFlag ? DEFEND_DODGE_BONUS : 0;
}

console.log('defendFactor while defending:', defendFactorFor(true), 'expected 0.6');
console.log('defendFactor while not defending:', defendFactorFor(false), 'expected 1');
console.log('defendDodgeBonus while defending:', defendDodgeBonusFor(true), 'expected 25');
console.log('defendDodgeBonus while not defending:', defendDodgeBonusFor(false), 'expected 0');

const rawDmg = 10;
const dmgDefending = Math.round(rawDmg * 1 * 1 * 1 * defendFactorFor(true));
const dmgNotDefending = Math.round(rawDmg * 1 * 1 * 1 * defendFactorFor(false));
console.log('graduated dmg while defending (rawDmg=10, no other modifiers):', dmgDefending, 'expected 6');
console.log('graduated dmg while not defending:', dmgNotDefending, 'expected 10');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_defend2.js`

Expected output (must match exactly):
```
defendFactor while defending: 0.6 expected 0.6
defendFactor while not defending: 1 expected 1
defendDodgeBonus while defending: 25 expected 25
defendDodgeBonus while not defending: 0 expected 0
graduated dmg while defending (rawDmg=10, no other modifiers): 6 expected 6
graduated dmg while not defending: 10 expected 10
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_defend2.js`

- [ ] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat: /defend performKick integration (dodge bonus, damage reduction)"
```

---

### Task 6: Защитная стойка — `/me`, `/helppvp` text

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: `/me` defend line**

Find the больничка `/me` block added in Task 3, Step 1 (search for `isHospitalized(msg.from.id)`), and insert the defend block immediately after its closing `}`:

```js
  if (isHospitalized(msg.from.id)) {
    lines.push(`🏥 В больничке (здоровье ${health.health}/${HOSPITAL_EXIT_HEALTH})`);
  }
  if (isDefending(msg.from.id)) {
    const defendRow = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(msg.from.id);
    const minutesLeft = Math.ceil((defendRow.defend_until - Math.floor(Date.now() / 1000)) / 60);
    lines.push(`🛡️ Защитная стойка (осталось ${minutesLeft} мин)`);
  }
```

(The full block above — replace the больничка-only 3 lines from Task 3 with these 7 lines, i.e. больничка's block stays exactly as-is, with the new defend block appended right after it.)

- [ ] **Step 2: `/helppvp` — add the `/defend` line**

Find (`bot.js`, last line of the `/helppvp` array — search for the `kuniTama` help line):

```js
    '/kuniTama — попытка получить бафф +25% крит и +25% уклонение, 10 мин (50% шанс успеха; тратит 2 энергии в любом случае; кулдаун = 10 мин в любом случае)',
  ].join('\n');
```

Replace with:

```js
    '/kuniTama — попытка получить бафф +25% крит и +25% уклонение, 10 мин (50% шанс успеха; тратит 2 энергии в любом случае; кулдаун = 10 мин в любом случае)',
    '/defend — встать в защитную стойку на 30 мин: +25 к увороту, −40% входящего урона (только обычный урон, не нат.100/жопу морковкой); атака снимает стойку; тратит 2 энергии, кулдаун = сама стойка',
  ].join('\n');
```

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "docs: add /defend to /me and /helppvp"
```

---

### Task 7: Manual verification (left to user)

Not automated — deployment is the user's own flow. After all tasks are pushed and the user restarts the bot (`pm2 restart tg-bot`), verify manually in the "Поединки" arena chat:

- [ ] Knock a warrior out (`/kick` a 0-HP hit, or a natural-100, or carrot ass) → confirm no 30-min mute is applied, and `/find`/`/me` for the victim shows 🏥 больничка status instead.
- [ ] `/kick` the hospitalized victim → confirm "лежит в больничке — недоступен для удара" refusal.
- [ ] Have the hospitalized player themselves run `/kick` on someone else → confirm they ARE allowed to attack, больничка status clears immediately (see 🏥 exit message), and their attack proceeds normally even if health is still under 30.
- [ ] Let a hospitalized player's health regenerate naturally (or check `/me` over time) → confirm regen is visibly faster than a non-hospitalized player's, and больничка status clears automatically once health reaches 30.
- [ ] Confirm passive regen for a NON-hospitalized player is now ~20/hour (double the old 10/hour) — e.g. compare `/me` health before/after a known elapsed time.
- [ ] `/defend` → confirm the confirmation message, then get hit by a real `/kick` → confirm the hit message's score comparison reflects the +25 dodge bonus, and any landed graduated-damage hit is visibly ~40% lower than it would otherwise be.
- [ ] While defending, get hit by a natural-100 or carrot "ass" → confirm damage is NOT reduced (full wipe still happens).
- [ ] While defending, run `/kick` yourself → confirm the "опускает защиту" message fires and the stance is gone (`/me` no longer shows it).
- [ ] Try `/defend` again immediately after using it once → confirm the "стойка уже активна" cooldown message.
- [ ] Try `/defend` with insufficient energy → confirm the energy-shortfall message, no state change.

---

## Self-Review

**Spec coverage:** больничка schema/constants/helper (✅ Task 1), damageHuman replacing the mute (✅ Task 1), isKnockedOut deletion (✅ Task 2), performKick target-block + attacker auto-break (✅ Task 2), regen rate doubling + больничка-aware healthRegenTick (✅ Task 2), /me + /find + /helppvp больничка text (✅ Task 3), defend schema/constants/helper/command (✅ Task 4), defend dodge bonus + damage reduction at every graduated site + attacker auto-break (✅ Task 5), defend /me + /helppvp text (✅ Task 6). No troll-bot changes anywhere (✅ — confirmed no task touches the troll-bot repo). bleedTick/arenaTick explicitly untouched (✅ — called out in the shared context section and not referenced by any task).

**Placeholder scan:** No TBD/TODO; every step has complete code or an exact command with expected output.

**Type consistency:** `isHospitalized(userId): boolean` and `isDefending(userId): boolean` are each defined once (Task 1, Task 4) and called with the same signature everywhere they're used later (Task 2, 3, 5, 6). `hospitalized_since` is always treated as "unix seconds or NULL," never as a boolean, consistently across `damageHuman`, `isHospitalized`, `healthRegenTick`, `/me`, `/find`, and the attacker auto-break. `defend_until` is always "unix seconds or NULL" consistently across `isDefending`, `/defend`, `performKick`'s dodge/damage integration, `/me`, and the attacker auto-break. `HOSPITAL_EXIT_HEALTH`/`HOSPITAL_REGEN_MULTIPLIER` (Task 1) and `DEFEND_*` (Task 4) constants are each defined exactly once and referenced by name everywhere else, no magic-number duplication.
