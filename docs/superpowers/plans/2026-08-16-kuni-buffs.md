# `/kuniFun`, `/kuniAlia`, `/kuniTama` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three public self-buff commands (`/kuniFun`, `/kuniAlia`, `/kuniTama`) that temporarily boost the caller's crit and/or dodge chance in `/kick`, each with its own 10-minute duration and matching cooldown.

**Architecture:** One new SQLite table (`buffs`), two new pure lookup helpers (`getCritThreshold`, `getHitThreshold`), three new `bot.onText` command handlers placed right after the existing `/kick` handler, and two one-line edits inside `/kick` itself to consult the new helpers instead of the hardcoded `50`/`90` thresholds. All in `c:\Users\123\Projects\tg-bot\bot.js`.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is `node --check` for syntax plus an isolated `node -e` script against a scratch in-memory DB, then a live smoke test, matching every other plan in this repo.

**Spec:** `docs/superpowers/specs/2026-08-16-kuni-buffs-design.md`

---

### Task 1: `buffs` table + threshold helpers

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:283-291` (new table, right after `health_regen_state`)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:838-843` (new helpers, right after `getUserHealth`)

- [x] **Step 1: Add the `buffs` table**

Find:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS health_regen_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_full_restore_date TEXT
  )
`);
db.prepare('INSERT OR IGNORE INTO health_regen_state (id, last_full_restore_date) VALUES (1, NULL)').run();

// Real, stealable weapons (see WEAPON_DEFS below and, in the sibling
// troll-bot repo, docs/superpowers/specs/2026-08-07-real-weapons-design.md)
```

Replace with:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS health_regen_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_full_restore_date TEXT
  )
`);
db.prepare('INSERT OR IGNORE INTO health_regen_state (id, last_full_restore_date) VALUES (1, NULL)').run();

// /kuniFun/kuniAlia/kuniTama self-buffs (see docs/superpowers/specs/
// 2026-08-16-kuni-buffs-design.md). Two independent slots — crit (written
// by kuniFun or kuniTama) and dodge (written by kuniAlia or kuniTama) —
// each with its own expiry. The three *_cd_until columns are independent
// per-command cooldowns, always equal to that command's own buff duration.
db.exec(`
  CREATE TABLE IF NOT EXISTS buffs (
    user_id INTEGER PRIMARY KEY,
    crit_mult REAL,
    crit_until INTEGER,
    dodge_mult REAL,
    dodge_until INTEGER,
    fun_cd_until INTEGER,
    alia_cd_until INTEGER,
    tama_cd_until INTEGER
  )
`);

// Real, stealable weapons (see WEAPON_DEFS below and, in the sibling
// troll-bot repo, docs/superpowers/specs/2026-08-07-real-weapons-design.md)
```

- [x] **Step 2: Add `getCritThreshold`/`getHitThreshold` helpers**

Find:

```js
// Lazily creates a 100/100 row on first access, same as troll-bot's own
// copy of this helper.
function getUserHealth(userId) {
  db.prepare('INSERT OR IGNORE INTO user_health (user_id, health, max_health) VALUES (?, 100, 100)').run(userId);
  return db.prepare('SELECT health, max_health, energy, max_energy FROM user_health WHERE user_id = ?').get(userId);
}

// Spends 1 energy for a /kick attempt. Returns the remaining energy on
```

Replace with:

```js
// Lazily creates a 100/100 row on first access, same as troll-bot's own
// copy of this helper.
function getUserHealth(userId) {
  db.prepare('INSERT OR IGNORE INTO user_health (user_id, health, max_health) VALUES (?, 100, 100)').run(userId);
  return db.prepare('SELECT health, max_health, energy, max_energy FROM user_health WHERE user_id = ?').get(userId);
}

// Base crit/injury threshold is 90 (see /kick below). An active kuniFun
// buff lowers it to 84 (+50% crit chance, ~1.54x), kuniTama to 87 (+25%,
// ~1.27x). crit_mult is only ever 1.5 or 1.25, so >= 1.5 disambiguates them.
function getCritThreshold(userId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT crit_mult, crit_until FROM buffs WHERE user_id = ?').get(userId);
  if (row && row.crit_until > now) return row.crit_mult >= 1.5 ? 84 : 87;
  return 90;
}

// Base hit threshold is 50 (see /kick below). A dodge buff on the
// defender raises the threshold the attacker's roll must clear: kuniAlia
// -> 75 (+50% dodge, ~1.50x), kuniTama -> 62 (+25%, ~1.24x).
function getHitThreshold(targetId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT dodge_mult, dodge_until FROM buffs WHERE user_id = ?').get(targetId);
  if (row && row.dodge_until > now) return row.dodge_mult >= 1.5 ? 75 : 62;
  return 50;
}

// Spends 1 energy for a /kick attempt. Returns the remaining energy on
```

- [x] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 4: Verify the threshold logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE buffs (user_id INTEGER PRIMARY KEY, crit_mult REAL, crit_until INTEGER, dodge_mult REAL, dodge_until INTEGER, fun_cd_until INTEGER, alia_cd_until INTEGER, tama_cd_until INTEGER)\`);

function getCritThreshold(userId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT crit_mult, crit_until FROM buffs WHERE user_id = ?').get(userId);
  if (row && row.crit_until > now) return row.crit_mult >= 1.5 ? 84 : 87;
  return 90;
}
function getHitThreshold(targetId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT dodge_mult, dodge_until FROM buffs WHERE user_id = ?').get(targetId);
  if (row && row.dodge_until > now) return row.dodge_mult >= 1.5 ? 75 : 62;
  return 50;
}

const now = Math.floor(Date.now() / 1000);
console.log('no buff crit:', getCritThreshold(1), 'expected 90');
console.log('no buff hit:', getHitThreshold(1), 'expected 50');

db.prepare('INSERT INTO buffs (user_id, crit_mult, crit_until) VALUES (1, 1.5, ?)').run(now + 600);
console.log('kuniFun active crit:', getCritThreshold(1), 'expected 84');

db.prepare('INSERT INTO buffs (user_id, dodge_mult, dodge_until) VALUES (2, 1.5, ?)').run(now + 600);
console.log('kuniAlia active hit vs user2:', getHitThreshold(2), 'expected 75');

db.prepare('INSERT INTO buffs (user_id, crit_mult, crit_until, dodge_mult, dodge_until) VALUES (3, 1.25, ?, 1.25, ?)').run(now + 600, now + 600);
console.log('kuniTama active crit:', getCritThreshold(3), 'expected 87');
console.log('kuniTama active hit vs user3:', getHitThreshold(3), 'expected 62');

db.prepare('UPDATE buffs SET crit_until = ? WHERE user_id = 1').run(now - 1);
console.log('expired kuniFun crit:', getCritThreshold(1), 'expected 90');
"
```

Expected output (in order):
```
no buff crit: 90 expected 90
no buff hit: 50 expected 50
kuniFun active crit: 84 expected 84
kuniAlia active hit vs user2: 75 expected 75
kuniTama active crit: 87 expected 87
kuniTama active hit vs user3: 62 expected 62
expired kuniFun crit: 90 expected 90
```

- [x] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: add buffs table and crit/dodge threshold helpers for kuni buffs"
git push
```

---

### Task 2: The three `/kuniFun`/`/kuniAlia`/`/kuniTama` command handlers

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1108-1111` (insert new handlers right after `/kick`, before the "Animal assign/unassign" block)

- [x] **Step 1: Insert the three handlers after `/kick`**

Find:

```js
      const stolenDef = WEAPON_DEFS[stolenKey];
      await bot.sendMessage(
        msg.chat.id,
        `${stolenDef.emoji} ${actorLabel} отобрал ${stolenDef.accusative} у ${targetLabel} и теперь бьёт ${stolenDef.instrumental} сам!`,
        threadOpts(msg)
      ).catch(() => {});
    }
  }
});

// --- Animal assign/unassign (admin only, reply required) ---
```

Replace with:

```js
      const stolenDef = WEAPON_DEFS[stolenKey];
      await bot.sendMessage(
        msg.chat.id,
        `${stolenDef.emoji} ${actorLabel} отобрал ${stolenDef.accusative} у ${targetLabel} и теперь бьёт ${stolenDef.instrumental} сам!`,
        threadOpts(msg)
      ).catch(() => {});
    }
  }
});

// --- /kuniFun, /kuniAlia, /kuniTama: public self-buffs, no reply/target
// needed (see docs/superpowers/specs/2026-08-16-kuni-buffs-design.md).
// Each command's cooldown always matches its own buff's 10-minute
// duration, so "on cooldown" and "buff still active" are the same check.
bot.onText(/\/kuniFun\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT fun_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.fun_cd_until > now) {
    const minutesLeft = Math.ceil((row.fun_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  const until = now + 600;
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, fun_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.5, crit_until = excluded.crit_until, fun_cd_until = excluded.fun_cd_until'
  ).run(msg.from.id, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни InternalFun и теперь стал более опасен ⚡ (+крит на 10 мин)`, threadOpts(msg));
});

bot.onText(/\/kuniAlia\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT alia_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.alia_cd_until > now) {
    const minutesLeft = Math.ceil((row.alia_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  const until = now + 600;
  db.prepare(
    'INSERT INTO buffs (user_id, dodge_mult, dodge_until, alia_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dodge_mult = 1.5, dodge_until = excluded.dodge_until, alia_cd_until = excluded.alia_cd_until'
  ).run(msg.from.id, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни AliyaKuzAli и теперь лучше уклоняется 🌀 (+уклонение на 10 мин)`, threadOpts(msg));
});

bot.onText(/\/kuniTama\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT tama_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.tama_cd_until > now) {
    const minutesLeft = Math.ceil((row.tama_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  const until = now + 600;
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, dodge_mult, dodge_until, tama_cd_until) VALUES (?, 1.25, ?, 1.25, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.25, crit_until = excluded.crit_until, dodge_mult = 1.25, dodge_until = excluded.dodge_until, tama_cd_until = excluded.tama_cd_until'
  ).run(msg.from.id, until, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни Tama и теперь стал опаснее и увёртливее ✨ (+крит и +уклонение на 10 мин)`, threadOpts(msg));
});

// --- Animal assign/unassign (admin only, reply required) ---
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Verify the cooldown/insert logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE buffs (user_id INTEGER PRIMARY KEY, crit_mult REAL, crit_until INTEGER, dodge_mult REAL, dodge_until INTEGER, fun_cd_until INTEGER, alia_cd_until INTEGER, tama_cd_until INTEGER)\`);

function castFun(userId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT fun_cd_until FROM buffs WHERE user_id = ?').get(userId);
  if (row && row.fun_cd_until > now) return 'on cooldown';
  const until = now + 600;
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, fun_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.5, crit_until = excluded.crit_until, fun_cd_until = excluded.fun_cd_until'
  ).run(userId, until, until);
  return 'cast';
}
function castAlia(userId) {
  const now = Math.floor(Date.now() / 1000);
  const until = now + 600;
  db.prepare(
    'INSERT INTO buffs (user_id, dodge_mult, dodge_until, alia_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dodge_mult = 1.5, dodge_until = excluded.dodge_until, alia_cd_until = excluded.alia_cd_until'
  ).run(userId, until, until);
  return 'cast';
}

console.log('first kuniFun cast:', castFun(1), 'expected cast');
console.log('immediate re-cast:', castFun(1), 'expected on cooldown');
console.log('kuniAlia cast on same user (independent slot):', castAlia(1), 'expected cast');
console.log('row after both:', db.prepare('SELECT crit_mult, dodge_mult FROM buffs WHERE user_id = 1').get(), 'expected { crit_mult: 1.5, dodge_mult: 1.5 }');
"
```

Expected output (in order):
```
first kuniFun cast: cast expected cast
immediate re-cast: on cooldown expected on cooldown
kuniAlia cast on same user (independent slot): cast expected cast
row after both: { crit_mult: 1.5, dodge_mult: 1.5 } expected { crit_mult: 1.5, dodge_mult: 1.5 }
```

- [x] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add /kuniFun /kuniAlia /kuniTama self-buff commands"
git push
```

---

### Task 3: Wire the buffs into `/kick`'s roll resolution

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1061-1089` (the `/kick` handler's roll/success/crit logic)

- [x] **Step 1: Replace the hardcoded hit and crit thresholds**

Find:

```js
  const weapon = pickWeaponForAttacker('human', msg.from.id, PVP_WEAPONS);
  const bodyPart = pick(PVP_BODY_PARTS);
  const roll = Math.floor(Math.random() * 101);
  const success = roll >= 50;
  const outcome = success ? '✅ удачно' : '❌ неудачно';
```

Replace with:

```js
  const weapon = pickWeaponForAttacker('human', msg.from.id, PVP_WEAPONS);
  const bodyPart = pick(PVP_BODY_PARTS);
  const roll = Math.floor(Math.random() * 101);
  const success = roll >= getHitThreshold(target.id);
  const outcome = success ? '✅ удачно' : '❌ неудачно';
```

Find:

```js
  if (roll >= 90) {
    const injuryType = pick(['arm', 'leg', 'head']);
```

Replace with:

```js
  if (roll >= getCritThreshold(msg.from.id)) {
    const injuryType = pick(['arm', 'leg', 'head']);
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: apply kuni buffs to /kick hit and crit thresholds"
git push
```

---

### Task 4: Manual end-to-end verification

**Files:** none (verification only, against the running bot — deploy is the user's own GitHub-based flow)

- [ ] **Step 1: Confirm each command casts and announces**

Send `/kuniFun`, `/kuniAlia`, `/kuniTama` (as different users, or the same user with `/kuniAlia`/`/kuniTama` after `/kuniFun`'s own cooldown check only blocks re-casting *itself*). Expected: each replies with its own flavor line naming InternalFun / AliyaKuzAli / Tama and the buff duration.

- [ ] **Step 2: Confirm cooldown blocking**

Immediately re-run the same command a second time. Expected: `<user>, бафф уже активен (ещё N мин).` with `N` close to 10.

- [ ] **Step 3: Confirm stacking**

Cast `/kuniFun` then `/kuniAlia` as the same user. Expected: both succeed (different cooldown columns, different slots) — neither blocks the other.

- [ ] **Step 4: Confirm the crit/dodge effect qualitatively**

While `/kuniFun` is active, run several `/kick`s and note crit/injury messages appear to come up somewhat more often than usual (11% -> ~17%, not reliably visible in a handful of tries, but shouldn't feel absent over ~15-20 attempts). While `/kuniAlia` is active on the *target*, have another user `/kick` them several times and note the "❌ неудачно" outcome appears somewhat more often than the normal ~50/50.

- [ ] **Step 5: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as the earlier tasks.
