# Crutch (Костыль) Real Weapon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth real, stealable weapon ("костыль", `×1.25` damage) owned by Дима (Telegram id `736180284`, no `@username`) that puts its victim into the existing "old man Dimon" status for 2 hours on any successful hit, working everywhere the other three real weapons work (tg-bot's `/kick`, and troll-bot's `/fight` + all four autonomous-attack functions).

**Architecture:** A `WEAPON_DEFS.crutch` entry duplicated in both repos, a `weapon_ownership` seed row pre-populated with Дима's known numeric id (skipping the usual username-based lazy resolution, since he has none), a nullable `dimon_until` column added to tg-bot's existing `dimoniacs` table, a new `applyDimon` helper (tg-bot: does the real write; troll-bot: a thin cross-process wrapper via `tgBotDb`, same shape as the existing `applyBleed`), and a sibling `if (weapon.key === 'crutch')` block next to every existing `if (weapon.key === 'scissors')` block across both repos' 6 combat call sites.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is `node --check` per repo plus isolated `node -e` scripts against scratch in-memory DBs for the two tasks with real branching logic (the `applyDimon` helper and the message-hook expiry check), then a live smoke test.

**Spec:** `docs/superpowers/specs/2026-08-17-crutch-weapon-design.md`

---

### Task 1: tg-bot schema — `dimon_until` column, weapon seed row, `WEAPON_DEFS`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:183-193` (dimoniacs table — add ALTER right after)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:326-328` (weapon_ownership seed rows)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:826-830` (WEAPON_DEFS)

- [x] **Step 1: Add the `dimon_until` column**

Find:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS dimoniacs (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    message_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
```

Replace with:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS dimoniacs (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    message_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
// Weapon-triggered timed "old man Dimon" status (see WEAPON_DEFS.crutch
// and applyDimon below) — NULL means the existing PERMANENT status set
// by admin /dimon (unchanged), a timestamp means a timed status from a
// crutch hit that auto-expires. Separate ALTER since dimoniacs already
// existed before this column — same idiom as user_health's hidden_until.
try {
  db.exec('ALTER TABLE dimoniacs ADD COLUMN dimon_until INTEGER');
} catch {}
```

- [x] **Step 2: Add the crutch weapon_ownership seed row**

Find:

```js
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)").run();
```

Replace with:

```js
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)").run();
// Дима has no public Telegram @username, so the usual seed_username lazy
// resolution (see the UPDATE ... WHERE seed_username = ? AND owner_user_id
// IS NULL below) can't apply to him — his numeric id is already known, so
// owner_user_id is populated immediately and seed_username stays NULL.
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('crutch', NULL, 'human', 736180284, NULL)").run();
```

- [x] **Step 3: Add the crutch WEAPON_DEFS entry**

Find:

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
};
```

Replace with:

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
  crutch: { name: 'костыль', instrumental: 'костылём', accusative: 'костыль', multiplier: 1.25, emoji: '🩼' },
};
```

- [x] **Step 4: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: add crutch weapon schema, seed row, and WEAPON_DEFS entry (tg-bot)"
git push
```

---

### Task 2: tg-bot `applyDimon` helper + message-hook expiry check

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:975-978` (right after `applyBleed`)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1846-1849` (old-man-speech message hook)

- [x] **Step 1: Add the `applyDimon` helper right after `applyBleed`**

Find:

```js
function applyBleed(userId, chatId) {
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}
```

Replace with:

```js
function applyBleed(userId, chatId) {
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}

// Weapon-triggered timed "old man Dimon" status (see WEAPON_DEFS.crutch).
// Never downgrades an existing PERMANENT status (dimon_until IS NULL, set
// by admin /dimon below) to a timed one — a crutch hit can't undo an
// admin's manual punishment. Write side only; the old-man-speech message
// hook further down is what actually reads/expires this.
function applyDimon(userId, chatId, username) {
  const existing = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = ?').get(userId);
  if (existing && existing.dimon_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 2 * 3600;
  db.prepare(
    'INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dimon_until = excluded.dimon_until, message_count = 0, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, until);
}
```

- [x] **Step 2: Add the lazy expiry check to the old-man-speech message hook**

Find:

```js
  // Dimon (старик) — в каждом третьем сообщении добавляем старческие обороты
  const dimonRow = db.prepare('SELECT message_count FROM dimoniacs WHERE user_id = ?').get(msg.from.id);
  if (dimonRow && msg.text && !msg.text.startsWith('/') && !msg.text.startsWith('**')) {
    const newCount = dimonRow.message_count + 1;
    db.prepare('UPDATE dimoniacs SET message_count = ? WHERE user_id = ?').run(newCount, msg.from.id);

    if (newCount % 3 === 0) {
      const oldMans = [
        '*кашель*', 'э-э-э', 'ой батенька', '*кряхтит*', 'е-хе-хе', '*вздыхает*',
        '*присел на пенек*', '*схватился за сердце*', '*потер спину*', '*охнул*',
        '*прихромал*', '*помассировал ноги*', '*согнулся*', '*заболела спина*'
      ];
      // 5% шанс: вместо обычного старческого оборота — конфузная фраза
      const dimonSpecials = ['пукнул', 'испортил воздух', 'описался', 'уснул'];
      const suffix = Math.random() < 0.05
        ? `*${dimonSpecials[Math.floor(Math.random() * dimonSpecials.length)]}*`
        : oldMans[Math.floor(Math.random() * oldMans.length)];
      const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `🧓 ${nick}: ${msg.text}\n${suffix}`, threadOpts(msg)).catch(() => {});
      return;
    }
  }
```

Replace with:

```js
  // Dimon (старик) — в каждом третьем сообщении добавляем старческие обороты
  const dimonRow = db.prepare('SELECT message_count, dimon_until FROM dimoniacs WHERE user_id = ?').get(msg.from.id);
  if (dimonRow && dimonRow.dimon_until && dimonRow.dimon_until * 1000 < Date.now()) {
    // Timed status (from a crutch hit) expired — lazily clean up, same
    // idiom as getUserInjury's injured_until check elsewhere in this file.
    db.prepare('DELETE FROM dimoniacs WHERE user_id = ?').run(msg.from.id);
  } else if (dimonRow && msg.text && !msg.text.startsWith('/') && !msg.text.startsWith('**')) {
    const newCount = dimonRow.message_count + 1;
    db.prepare('UPDATE dimoniacs SET message_count = ? WHERE user_id = ?').run(newCount, msg.from.id);

    if (newCount % 3 === 0) {
      const oldMans = [
        '*кашель*', 'э-э-э', 'ой батенька', '*кряхтит*', 'е-хе-хе', '*вздыхает*',
        '*присел на пенек*', '*схватился за сердце*', '*потер спину*', '*охнул*',
        '*прихромал*', '*помассировал ноги*', '*согнулся*', '*заболела спина*'
      ];
      // 5% шанс: вместо обычного старческого оборота — конфузная фраза
      const dimonSpecials = ['пукнул', 'испортил воздух', 'описался', 'уснул'];
      const suffix = Math.random() < 0.05
        ? `*${dimonSpecials[Math.floor(Math.random() * dimonSpecials.length)]}*`
        : oldMans[Math.floor(Math.random() * oldMans.length)];
      const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `🧓 ${nick}: ${msg.text}\n${suffix}`, threadOpts(msg)).catch(() => {});
      return;
    }
  }
```

- [x] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 4: Verify `applyDimon` and the expiry check in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE dimoniacs (user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, username TEXT, added_by INTEGER, added_by_name TEXT, message_count INTEGER DEFAULT 0, created_at INTEGER DEFAULT (strftime('%s','now')), dimon_until INTEGER)\`);

function applyDimon(userId, chatId, username) {
  const existing = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = ?').get(userId);
  if (existing && existing.dimon_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 2 * 3600;
  db.prepare(
    'INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dimon_until = excluded.dimon_until, message_count = 0, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, until);
}

// Fresh user: crutch hit creates a timed row
applyDimon(1, 100, 'alice');
const row1 = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = 1').get();
console.log('fresh timed row:', row1.dimon_until !== null, 'expected true');

// Admin-permanent user (dimon_until NULL): crutch hit must NOT downgrade
db.prepare('INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (2, 100, ?, 0, NULL)').run('bob');
applyDimon(2, 100, 'bob');
const row2 = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = 2').get();
console.log('permanent status preserved:', row2.dimon_until === null, 'expected true');

// Message-count reset on a fresh timed re-hit
db.prepare('UPDATE dimoniacs SET message_count = 5 WHERE user_id = 1').run();
applyDimon(1, 100, 'alice');
const row3 = db.prepare('SELECT message_count FROM dimoniacs WHERE user_id = 1').get();
console.log('message_count reset on re-hit:', row3.message_count, 'expected 0');

// Expiry check logic (mirrors the message-hook branch)
db.prepare('UPDATE dimoniacs SET dimon_until = ? WHERE user_id = 1').run(Math.floor(Date.now() / 1000) - 10);
const dimonRow = db.prepare('SELECT message_count, dimon_until FROM dimoniacs WHERE user_id = ?').get(1);
const expired = dimonRow && dimonRow.dimon_until && dimonRow.dimon_until * 1000 < Date.now();
console.log('expired timed status detected:', expired, 'expected true');
"
```

Expected output (in order):
```
fresh timed row: true expected true
permanent status preserved: true expected true
message_count reset on re-hit: 0 expected 0
expired timed status detected: true expected true
```

- [x] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: add applyDimon helper and timed-expiry check to old-man-speech hook (tg-bot)"
git push
```

---

### Task 3: tg-bot `/kick` wiring

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1119-1125` (right after the existing scissors block in `/kick`)

- [x] **Step 1: Add the crutch block right after the scissors block**

Find:

```js
  if (weapon.key === 'scissors') {
    applyBleed(target.id, msg.chat.id);
    await bot.sendMessage(msg.chat.id, `🩸 ${targetLabel} начинает истекать кровью от ржавых ножниц!`, threadOpts(msg)).catch(() => {});
    if (Math.random() < 0.05) {
      await bot.sendMessage(msg.chat.id, `✂️ ${actorLabel} случайно отчекрыжил ${targetLabel} палец ржавыми ножницами!`, threadOpts(msg)).catch(() => {});
    }
  }
```

Replace with:

```js
  if (weapon.key === 'scissors') {
    applyBleed(target.id, msg.chat.id);
    await bot.sendMessage(msg.chat.id, `🩸 ${targetLabel} начинает истекать кровью от ржавых ножниц!`, threadOpts(msg)).catch(() => {});
    if (Math.random() < 0.05) {
      await bot.sendMessage(msg.chat.id, `✂️ ${actorLabel} случайно отчекрыжил ${targetLabel} палец ржавыми ножницами!`, threadOpts(msg)).catch(() => {});
    }
  }

  if (weapon.key === 'crutch') {
    applyDimon(target.id, msg.chat.id, target.username);
    await bot.sendMessage(msg.chat.id, `🩼 ${targetLabel} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`, threadOpts(msg)).catch(() => {});
  }
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: apply crutch weapon effect in /kick (tg-bot)"
git push
```

---

### Task 4: troll-bot schema — weapon seed row and `WEAPON_DEFS`

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:98-101` (weapon_ownership seed rows, inside the startup `try` block)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:112-116` (WEAPON_DEFS)

- [x] **Step 1: Add the crutch weapon_ownership seed row**

Find:

```js
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)").run();
} catch (err) {
```

Replace with:

```js
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)").run();
  // Дима has no public Telegram @username, so the usual seed_username
  // lazy resolution can't apply — his numeric id is already known.
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('crutch', NULL, 'human', 736180284, NULL)").run();
} catch (err) {
```

- [x] **Step 2: Add the crutch WEAPON_DEFS entry**

Find:

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
};
```

Replace with:

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
  crutch: { name: 'костыль', instrumental: 'костылём', accusative: 'костыль', multiplier: 1.25, emoji: '🩼' },
};
```

- [x] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add crutch weapon seed row and WEAPON_DEFS entry (troll-bot)"
git push
```

---

### Task 5: troll-bot `applyDimon` cross-process wrapper

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:251-255` (right after `applyBleed`)

- [x] **Step 1: Add the `applyDimon` wrapper right after `applyBleed`**

Find:

```js
function applyBleed(userId, chatId) {
  if (!tgBotDb) return;
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  tgBotDb.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}
```

Replace with:

```js
function applyBleed(userId, chatId) {
  if (!tgBotDb) return;
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  tgBotDb.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}

// Cross-process write side of the crutch weapon's timed "old man Dimon"
// status — tg-bot owns the dimoniacs table and the message hook that
// reads/expires it; this just writes into it, same relationship this
// file already has with applyBleed above. Never downgrades an existing
// PERMANENT status (dimon_until IS NULL, set by admin /dimon in tg-bot).
function applyDimon(userId, chatId, username) {
  if (!tgBotDb) return;
  const existing = tgBotDb.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = ?').get(userId);
  if (existing && existing.dimon_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 2 * 3600;
  tgBotDb.prepare(
    'INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dimon_until = excluded.dimon_until, message_count = 0, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, until);
}
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Verify `applyDimon`'s permanent-vs-timed branching in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE dimoniacs (user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, username TEXT, added_by INTEGER, added_by_name TEXT, message_count INTEGER DEFAULT 0, created_at INTEGER DEFAULT (strftime('%s','now')), dimon_until INTEGER)\`);

function applyDimon(userId, chatId, username) {
  const existing = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = ?').get(userId);
  if (existing && existing.dimon_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 2 * 3600;
  db.prepare(
    'INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dimon_until = excluded.dimon_until, message_count = 0, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, until);
}

applyDimon(1, 200, 'carl');
const row1 = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = 1').get();
console.log('fresh timed row via troll-bot-shaped call:', row1.dimon_until !== null, 'expected true');

db.prepare('INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (2, 200, ?, 0, NULL)').run('dave');
applyDimon(2, 200, 'dave');
const row2 = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = 2').get();
console.log('permanent status preserved (troll-triggered):', row2.dimon_until === null, 'expected true');
"
```

Expected output (in order):
```
fresh timed row via troll-bot-shaped call: true expected true
permanent status preserved (troll-triggered): true expected true
```

(This mirrors Task 2's own verification of the same logic, since `applyDimon`'s branching is identical between the two repos — the only difference is the `if (!tgBotDb) return;` guard and `tgBotDb.prepare` vs `db.prepare`, neither of which changes the branching behavior being tested here.)

- [x] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add applyDimon cross-process wrapper (troll-bot)"
git push
```

---

### Task 6: troll-bot `performFight` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2165-2175` (inside `performFight`)

- [x] **Step 1: Add the crutch block right after the scissors block**

Find:

```js
  if (trollSwing.success) {
    const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * trollWeapon.multiplier);
    const humanHealth = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${challengerHealth.health} -> ${humanHealth})`).catch(() => {});
    if (trollWeapon.key === 'scissors') {
      applyBleed(from.id, chatId);
      await bot.sendMessage(chatId, `🩸 ${actorName(from)} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
      if (Math.random() < 0.05) {
        await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${actorName(from)} палец ржавыми ножницами!`).catch(() => {});
      }
    }
```

Replace with:

```js
  if (trollSwing.success) {
    const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * trollWeapon.multiplier);
    const humanHealth = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${challengerHealth.health} -> ${humanHealth})`).catch(() => {});
    if (trollWeapon.key === 'scissors') {
      applyBleed(from.id, chatId);
      await bot.sendMessage(chatId, `🩸 ${actorName(from)} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
      if (Math.random() < 0.05) {
        await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${actorName(from)} палец ржавыми ножницами!`).catch(() => {});
      }
    }
    if (trollWeapon.key === 'crutch') {
      applyDimon(from.id, chatId, from.username || from.first_name);
      await bot.sendMessage(chatId, `🩼 ${actorName(from)} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`).catch(() => {});
    }
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: apply crutch weapon effect in performFight (troll-bot)"
git push
```

---

### Task 7: troll-bot `performDrink` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2368-2378` (inside `performDrink`, inside its 3-swing `for` loop)

- [x] **Step 1: Add the crutch block right after the scissors block**

Find:

```js
      const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
      const before = getUserHealth(from.id);
      const after = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
      await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
      if (weapon.key === 'scissors') {
        applyBleed(from.id, chatId);
        await bot.sendMessage(chatId, `🩸 ${actorName(from)} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
        if (Math.random() < 0.05) {
          await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${actorName(from)} палец ржавыми ножницами!`).catch(() => {});
        }
      }
```

Replace with:

```js
      const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
      const before = getUserHealth(from.id);
      const after = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
      await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
      if (weapon.key === 'scissors') {
        applyBleed(from.id, chatId);
        await bot.sendMessage(chatId, `🩸 ${actorName(from)} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
        if (Math.random() < 0.05) {
          await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${actorName(from)} палец ржавыми ножницами!`).catch(() => {});
        }
      }
      if (weapon.key === 'crutch') {
        applyDimon(from.id, chatId, from.username || from.first_name);
        await bot.sendMessage(chatId, `🩼 ${actorName(from)} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`).catch(() => {});
      }
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: apply crutch weapon effect in performDrink (troll-bot)"
git push
```

---

### Task 8: troll-bot `triggerDrunkAttack` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2699-2707` (inside `triggerDrunkAttack`)

- [x] **Step 1: Add the crutch block right after the scissors block**

`triggerDrunkAttack` and `triggerFasAttack` (Task 9) have byte-identical scissors blocks — use the unique `logAction(target.userId, target.username || target.firstName, 'drunk_attack')` line earlier in this same function to confirm you're editing the right one before applying this Find/Replace (that exact string, `'drunk_attack'`, only appears in this function).

Find:

```js
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (weapon.key === 'scissors') {
    applyBleed(target.userId, chatId);
    bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
    if (Math.random() < 0.05) {
      bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
    }
  }
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
```

(This exact 13-line sequence appears twice in the file — once in `triggerDrunkAttack`, once in `triggerFasAttack`. This task's Find/Replace applies to the FIRST occurrence, the one preceded earlier in the same function by `logAction(target.userId, target.username || target.firstName, 'drunk_attack')`. If your editor/tool matches on exact text without location awareness, locate this occurrence specifically — do not touch the second one, which is Task 9.)

Replace with:

```js
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (weapon.key === 'scissors') {
    applyBleed(target.userId, chatId);
    bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
    if (Math.random() < 0.05) {
      bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
    }
  }
  if (weapon.key === 'crutch') {
    applyDimon(target.userId, chatId, target.username || target.firstName);
    bot.sendMessage(chatId, `🩼 ${name} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`).catch(() => {});
  }
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Verify only `triggerDrunkAttack` was touched, not `triggerFasAttack`**

Run: `grep -n "weapon.key === 'crutch'" bot.js`
Expected: exactly ONE match so far (this task's), inside `triggerDrunkAttack`. (Task 9 will add the second.)

- [x] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: apply crutch weapon effect in triggerDrunkAttack (troll-bot)"
git push
```

---

### Task 9: troll-bot `triggerFasAttack` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2776-2784` (inside `triggerFasAttack`)

- [x] **Step 1: Add the crutch block right after the scissors block**

This is the SECOND occurrence of the byte-identical 13-line sequence described in Task 8 — confirm you're editing the occurrence preceded earlier in its function by `logAction(target.userId, target.username || target.firstName, 'fas_attack')` (not `'drunk_attack'`, which is Task 8's and should already show a crutch block from the previous task).

Find:

```js
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (weapon.key === 'scissors') {
    applyBleed(target.userId, chatId);
    bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
    if (Math.random() < 0.05) {
      bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
    }
  }
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
```

Replace with:

```js
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (weapon.key === 'scissors') {
    applyBleed(target.userId, chatId);
    bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
    if (Math.random() < 0.05) {
      bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
    }
  }
  if (weapon.key === 'crutch') {
    applyDimon(target.userId, chatId, target.username || target.firstName);
    bot.sendMessage(chatId, `🩼 ${name} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`).catch(() => {});
  }
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Verify both call sites now have the crutch block**

Run: `grep -n "weapon.key === 'crutch'" bot.js`
Expected: exactly TWO matches now (Task 8's in `triggerDrunkAttack`, this task's in `triggerFasAttack`).

- [x] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: apply crutch weapon effect in triggerFasAttack (troll-bot)"
git push
```

---

### Task 10: troll-bot `triggerFoodSteal` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2913-2921` (inside `triggerFoodSteal`, inside its `for` loop)

- [x] **Step 1: Add the crutch block right after the scissors block**

Find:

```js
    const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
    if (weapon.key === 'scissors') {
      applyBleed(target.userId, chatId);
      await bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
      if (Math.random() < 0.05) {
        await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
      }
    }
    if (swing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(target.userId, injuryType);
```

Replace with:

```js
    const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
    if (weapon.key === 'scissors') {
      applyBleed(target.userId, chatId);
      await bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
      if (Math.random() < 0.05) {
        await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
      }
    }
    if (weapon.key === 'crutch') {
      applyDimon(target.userId, chatId, target.username || target.firstName);
      await bot.sendMessage(chatId, `🩼 ${name} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`).catch(() => {});
    }
    if (swing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(target.userId, injuryType);
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Verify all 5 troll-bot call sites now have the crutch block**

Run: `grep -n "weapon.key === 'crutch'\|trollWeapon.key === 'crutch'" bot.js`
Expected: exactly FIVE matches now (`performFight`, `performDrink`, `triggerDrunkAttack`, `triggerFasAttack`, `triggerFoodSteal`).

- [x] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: apply crutch weapon effect in triggerFoodSteal (troll-bot)"
git push
```

---

### Task 11: Manual end-to-end verification

**Files:** none (verification only, against the running bots — deploy is the user's own GitHub-based flow, both repos)

- [ ] **Step 1: Confirm Дима is holding the crutch**

On prod, check `weapon_ownership` for `weapon_key = 'crutch'` and confirm `owner_user_id = 736180284`.

- [ ] **Step 2: Confirm `/kick` applies the effect**

Have Дима (or whoever currently holds the crutch, if it's been stolen since) `/kick` someone. Expected: the damage message, then `🩼 {target} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`, then the victim's own chat messages start getting old-man phrases appended every third message (same as an admin-triggered `/dimon`).

- [ ] **Step 3: Confirm it self-expires after 2 hours (or a temporarily shortened window for testing)**

Either wait 2 hours, or temporarily run `UPDATE dimoniacs SET dimon_until = strftime('%s','now') + 60 WHERE user_id = <victim>` on prod's `mutes.db` to shorten the window for a manual test. Expected: after the window passes, the victim's next message is NOT mangled with an old-man phrase, and the `dimoniacs` row for them is gone (no admin `/undimon` needed).

- [ ] **Step 4: Confirm a permanent `/dimon` isn't downgraded by a crutch hit**

As admin, `/dimon` someone (permanent). Have Дима `/kick` that same person with the crutch. Expected: still dimonized after the crutch hit's 2-hour window would have expired — a `SELECT dimon_until FROM dimoniacs WHERE user_id = <that person>` on prod should still show `NULL`.

- [ ] **Step 5: Confirm cross-repo behavior if the crutch changes hands**

If a crit on `/kick` or a troll-side crit ever steals the crutch (5% weapon-steal-on-crit, existing mechanic, not new to this feature), confirm the new holder's hits also trigger the Dimon effect — this exercises the shared `weapon_ownership`/`WEAPON_DEFS.crutch` wiring working identically regardless of who holds it. Not required to force this scenario immediately; note it as covered by design (same steal mechanic as bat/axe/scissors) if it doesn't come up naturally during testing.

- [ ] **Step 6: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as the earlier tasks (in whichever repo needed the fix).
