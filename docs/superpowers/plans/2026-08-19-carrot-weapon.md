# Carrot Weapon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 6th real, stealable weapon "морковка" (carrot) to `/kick` — on a successful hit, one of 5 random "holes" resolves to a different effect (reduced damage ×0.8/0.9/0.5, a +20 heal, or a full health wipe that reuses the existing knockout/mute/steal-offer path), plus a 20-minute `/cat`/`/fox` status on any successful hit.

**Architecture:** A `WEAPON_DEFS.carrot` entry (no fixed `multiplier` — the effect is resolved per-hit instead), a `weapon_ownership` seed row for `@MashaZaykaaa`, a new `applyTimedAnimal` helper (mirrors `crutch`'s `applyDimon`: never downgrades a permanent animal status), a lazy-expiry check added to the two existing places that read a user's `animals` row, an `if (weapon.key === 'carrot') {...} else {...}` restructuring of `/kick`'s damage-calculation block, a crit-suppression tweak for the "ass" outcome, and a one-line special case in `/me`'s weapon-display loop.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is `node --check` for syntax, two isolated `node -e` scripts (one for the DB-level `applyTimedAnimal`/expiry logic, one for the health-math clamps), then a live smoke test.

**Spec:** `docs/superpowers/specs/2026-08-19-carrot-weapon-design.md`

---

### Task 1: Schema, `WEAPON_DEFS`, and weapon seed row

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:113-123` (the `animals` table — add ALTER right after)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:341-349` (weapon_ownership seed rows)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:847-853` (WEAPON_DEFS)

- [ ] **Step 1: Add the `animal_until` column**

Find:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS animals (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    animal TEXT NOT NULL,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
```

Replace with:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS animals (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    animal TEXT NOT NULL,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
// Weapon-triggered timed animal status (see WEAPON_DEFS.carrot and
// applyTimedAnimal below) — NULL means the existing PERMANENT status
// set by /pig, /cat, /fox etc. (unchanged), a timestamp means a timed
// status from a carrot hit that auto-expires. Same idiom as crutch's
// dimon_until column.
try {
  db.exec('ALTER TABLE animals ADD COLUMN animal_until INTEGER');
} catch {}
```

- [ ] **Step 2: Add the carrot weapon_ownership seed row**

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
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('carrot', 'MashaZaykaaa', 'human', NULL, NULL)").run();
```

(This new line goes right after the `scissors` line and before the existing `crutch`/`horns` lines that already follow it — do not reorder those, just insert this one line in between.)

- [ ] **Step 3: Add the carrot WEAPON_DEFS entry**

Find:

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
  crutch: { name: 'костыль', instrumental: 'костылём', accusative: 'костыль', multiplier: 1.25, emoji: '🩼' },
  horns: { name: 'рога', instrumental: 'рогами', accusative: 'рога', multiplier: 2, emoji: '🐂' },
};
```

Replace with:

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
  crutch: { name: 'костыль', instrumental: 'костылём', accusative: 'костыль', multiplier: 1.25, emoji: '🩼' },
  horns: { name: 'рога', instrumental: 'рогами', accusative: 'рога', multiplier: 2, emoji: '🐂' },
  carrot: { name: 'морковка', instrumental: 'морковкой', accusative: 'морковку', emoji: '🥕' },
};
```

Note `carrot` deliberately has no `multiplier` field — nothing generic reads it, since `/kick`'s damage calculation special-cases `weapon.key === 'carrot'` entirely (Task 3) instead of ever reaching the generic `dmg = Math.round(rawDmg * weapon.multiplier)` line for this weapon.

- [ ] **Step 4: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: add carrot weapon schema, seed row, and WEAPON_DEFS entry"
git push
```

---

### Task 2: `applyTimedAnimal` helper + lazy-expiry at both read sites

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1016-1024` (right after `applyDimon`)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:2058-2085` (sticker-OCR branch)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:2087-2090` (main text branch)

**Note on line numbers:** Task 1 added ~10 lines earlier in the file. Locate every Find block below by its surrounding text, not by trusting these line numbers.

- [ ] **Step 1: Add the `applyTimedAnimal` helper right after `applyDimon`**

Find:

```js
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

Replace with:

```js
function applyDimon(userId, chatId, username) {
  const existing = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = ?').get(userId);
  if (existing && existing.dimon_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 2 * 3600;
  db.prepare(
    'INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dimon_until = excluded.dimon_until, message_count = 0, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, until);
}

// Weapon-triggered timed animal status (see WEAPON_DEFS.carrot). Never
// downgrades an existing PERMANENT status (animal_until IS NULL, set
// by /pig, /cat, /fox etc.) to a timed one — same "never downgrade
// permanent" guarantee as applyDimon above, for the same reason (a
// weapon hit can't undo an admin's manual assignment).
function applyTimedAnimal(userId, chatId, username, animalType) {
  const existing = db.prepare('SELECT animal_until FROM animals WHERE user_id = ?').get(userId);
  if (existing && existing.animal_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare(
    'INSERT INTO animals (user_id, chat_id, username, animal, animal_until) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET animal = excluded.animal, animal_until = excluded.animal_until, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, animalType, until);
}
```

- [ ] **Step 2: Add lazy expiry to the sticker-OCR branch's animal read**

Find:

```js
        const aRow = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(msg.from.id);
        const eRow = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(msg.from.id);
```

Replace with:

```js
        let aRow = db.prepare('SELECT animal, animal_until FROM animals WHERE user_id = ?').get(msg.from.id);
        if (aRow && aRow.animal_until && aRow.animal_until * 1000 < Date.now()) {
          db.prepare('DELETE FROM animals WHERE user_id = ?').run(msg.from.id);
          aRow = null;
        }
        const eRow = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(msg.from.id);
```

(The `const aRow` becomes `let aRow` since it may be reassigned to `null` on expiry — everything downstream that reads `aRow` in this branch, e.g. `if (aRow) { const { emoji, sound } = ANIMALS[aRow.animal] || ANIMALS.pig; ... }`, is unchanged and works correctly either way.)

- [ ] **Step 3: Add lazy expiry to the main text branch's animal read**

Find:

```js
  const estetRow = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(msg.from.id);
  const podhalimRow = db.prepare('SELECT 1 FROM podhalims WHERE user_id = ?').get(msg.from.id);
  const animalRow = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(msg.from.id);
  const ramzan = db.prepare('SELECT 1 FROM ramzans WHERE user_id = ?').get(msg.from.id);
```

Replace with:

```js
  const estetRow = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(msg.from.id);
  const podhalimRow = db.prepare('SELECT 1 FROM podhalims WHERE user_id = ?').get(msg.from.id);
  let animalRow = db.prepare('SELECT animal, animal_until FROM animals WHERE user_id = ?').get(msg.from.id);
  if (animalRow && animalRow.animal_until && animalRow.animal_until * 1000 < Date.now()) {
    db.prepare('DELETE FROM animals WHERE user_id = ?').run(msg.from.id);
    animalRow = null;
  }
  const ramzan = db.prepare('SELECT 1 FROM ramzans WHERE user_id = ?').get(msg.from.id);
```

- [ ] **Step 4: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Verify `applyTimedAnimal` and the expiry logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE animals (user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, username TEXT, animal TEXT NOT NULL, added_by INTEGER, added_by_name TEXT, created_at INTEGER DEFAULT (strftime('%s','now')), animal_until INTEGER)\`);

function applyTimedAnimal(userId, chatId, username, animalType) {
  const existing = db.prepare('SELECT animal_until FROM animals WHERE user_id = ?').get(userId);
  if (existing && existing.animal_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare(
    'INSERT INTO animals (user_id, chat_id, username, animal, animal_until) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET animal = excluded.animal, animal_until = excluded.animal_until, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, animalType, until);
}

applyTimedAnimal(1, 100, 'alice', 'cat');
const row1 = db.prepare('SELECT animal, animal_until FROM animals WHERE user_id = 1').get();
console.log('fresh timed row:', row1.animal, row1.animal_until !== null, 'expected cat true');

db.prepare('INSERT INTO animals (user_id, chat_id, username, animal, animal_until) VALUES (2, 100, ?, ?, NULL)').run('bob', 'pig');
applyTimedAnimal(2, 100, 'bob', 'fox');
const row2 = db.prepare('SELECT animal, animal_until FROM animals WHERE user_id = 2').get();
console.log('permanent status preserved:', row2.animal, row2.animal_until === null, 'expected pig true');

db.prepare('UPDATE animals SET animal_until = ? WHERE user_id = 1').run(Math.floor(Date.now()/1000) - 10);
let aRow = db.prepare('SELECT animal, animal_until FROM animals WHERE user_id = ?').get(1);
if (aRow && aRow.animal_until && aRow.animal_until * 1000 < Date.now()) {
  db.prepare('DELETE FROM animals WHERE user_id = ?').run(1);
  aRow = null;
}
console.log('expired row cleaned up:', aRow, 'expected null');
console.log('row actually deleted:', db.prepare('SELECT * FROM animals WHERE user_id = 1').get(), 'expected undefined');
"
```

Expected output (in order):
```
fresh timed row: cat true expected cat true
permanent status preserved: pig true expected pig true
expired row cleaned up: null expected null
row actually deleted: undefined expected undefined
```

- [ ] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat: add applyTimedAnimal helper and lazy-expiry for carrot's cat/fox status"
git push
```

---

### Task 3: `/kick` damage-calc restructuring, holes, cat/fox, crit suppression

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1155-1199` (the `/kick` handler's damage-calc block through the crit block)

**Note on line numbers:** Tasks 1-2 added lines earlier in the file. Locate this Find block by its surrounding text.

- [ ] **Step 1: Restructure the damage calc, add hole outcomes, cat/fox application, and crit suppression**

Find:

```js
  const targetHealthBefore = getUserHealth(target.id);
  const rawDmg = Math.floor(Math.random() * 20) + 1;
  const dmg = Math.round(rawDmg * weapon.multiplier);
  const targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
  await bot.sendMessage(
    msg.chat.id,
    `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
    threadOpts(msg)
  ).catch(() => {});

  if (weapon.key === 'scissors') {
    applyBleed(target.id, msg.chat.id);
    await bot.sendMessage(msg.chat.id, `🩸 ${targetLabel} начинает истекать кровью от ржавых ножниц!`, threadOpts(msg)).catch(() => {});
    if (Math.random() < 0.05) {
      await bot.sendMessage(msg.chat.id, `✂️ ${actorLabel} случайно отчекрыжил ${targetLabel} палец ржавыми ножницами!`, threadOpts(msg)).catch(() => {});
    }
  }

  if (weapon.key === 'crutch') {
    applyDimon(target.id, msg.chat.id, target.username || target.firstName);
    await bot.sendMessage(msg.chat.id, `🩼 ${targetLabel} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`, threadOpts(msg)).catch(() => {});
  }

  if (roll >= getCritThreshold(msg.from.id)) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healHours = applyInjury(target.id, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      msg.chat.id,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healHours} ч).`,
      threadOpts(msg)
    ).catch(() => {});
    if (weapon.key === 'horns') {
      await bot.sendMessage(msg.chat.id, `🐂 ${actorLabel} насадила ${targetLabel} на рога!`, threadOpts(msg)).catch(() => {});
    }
    const stolenKey = maybeStealWeapon(target.id, { type: 'human', userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      await bot.sendMessage(
        msg.chat.id,
        `${stolenDef.emoji} ${actorLabel} отобрал ${stolenDef.accusative} у ${targetLabel} и теперь бьёт ${stolenDef.instrumental} сам!`,
        threadOpts(msg)
      ).catch(() => {});
    }
  }
```

Replace with:

```js
  const targetHealthBefore = getUserHealth(target.id);
  let targetHealthAfter;
  let hole = null;

  if (weapon.key === 'carrot') {
    const holes = ['ear', 'nose', 'mouth', 'dick', 'ass'];
    hole = holes[Math.floor(Math.random() * holes.length)];
    const rawDmg = Math.floor(Math.random() * 20) + 1;

    if (hole === 'ear') {
      const dmg = Math.round(rawDmg * 0.8);
      targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
      await bot.sendMessage(msg.chat.id, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в ухо! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msg)).catch(() => {});
    } else if (hole === 'nose') {
      const dmg = Math.round(rawDmg * 0.9);
      targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
      await bot.sendMessage(msg.chat.id, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в нос! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msg)).catch(() => {});
    } else if (hole === 'mouth') {
      const dmg = Math.round(rawDmg * 0.5);
      targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
      await bot.sendMessage(msg.chat.id, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в рот! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msg)).catch(() => {});
    } else if (hole === 'dick') {
      targetHealthAfter = Math.min(targetHealthBefore.max_health, targetHealthBefore.health + 20);
      const healed = targetHealthAfter - targetHealthBefore.health;
      db.prepare('UPDATE user_health SET health = ? WHERE user_id = ?').run(targetHealthAfter, target.id);
      await bot.sendMessage(msg.chat.id, `🥕😳 ${actorLabel} тычет ${targetLabel} морковкой... не туда! ${targetLabel} получает +${healed} здоровья и оргазм (${targetHealthBefore.health} -> ${targetHealthAfter})!`, threadOpts(msg)).catch(() => {});
    } else {
      targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, targetHealthBefore.health);
      await bot.sendMessage(msg.chat.id, `🥕💥 ${actorLabel} загоняет ${targetLabel} морковку в очко по самые уши! Вся жизнь снесена, ${targetLabel} в отключке (${targetHealthBefore.health} -> ${targetHealthAfter})!`, threadOpts(msg)).catch(() => {});
    }

    const animalType = Math.random() < 0.5 ? 'cat' : 'fox';
    applyTimedAnimal(target.id, msg.chat.id, target.username || target.firstName, animalType);
    const animalMsg = animalType === 'cat'
      ? `🐱 ${targetLabel} на 20 минут теперь мяукает как кошка!`
      : `🦊 ${targetLabel} на 20 минут теперь рычит как лиса!`;
    await bot.sendMessage(msg.chat.id, animalMsg, threadOpts(msg)).catch(() => {});
  } else {
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const dmg = Math.round(rawDmg * weapon.multiplier);
    targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
    await bot.sendMessage(
      msg.chat.id,
      `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
      threadOpts(msg)
    ).catch(() => {});
  }

  if (weapon.key === 'scissors') {
    applyBleed(target.id, msg.chat.id);
    await bot.sendMessage(msg.chat.id, `🩸 ${targetLabel} начинает истекать кровью от ржавых ножниц!`, threadOpts(msg)).catch(() => {});
    if (Math.random() < 0.05) {
      await bot.sendMessage(msg.chat.id, `✂️ ${actorLabel} случайно отчекрыжил ${targetLabel} палец ржавыми ножницами!`, threadOpts(msg)).catch(() => {});
    }
  }

  if (weapon.key === 'crutch') {
    applyDimon(target.id, msg.chat.id, target.username || target.firstName);
    await bot.sendMessage(msg.chat.id, `🩼 ${targetLabel} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`, threadOpts(msg)).catch(() => {});
  }

  if (roll >= getCritThreshold(msg.from.id) && !(weapon.key === 'carrot' && hole === 'ass')) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healHours = applyInjury(target.id, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      msg.chat.id,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healHours} ч).`,
      threadOpts(msg)
    ).catch(() => {});
    if (weapon.key === 'horns') {
      await bot.sendMessage(msg.chat.id, `🐂 ${actorLabel} насадила ${targetLabel} на рога!`, threadOpts(msg)).catch(() => {});
    }
    const stolenKey = maybeStealWeapon(target.id, { type: 'human', userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      await bot.sendMessage(
        msg.chat.id,
        `${stolenDef.emoji} ${actorLabel} отобрал ${stolenDef.accusative} у ${targetLabel} и теперь бьёт ${stolenDef.instrumental} сам!`,
        threadOpts(msg)
      ).catch(() => {});
    }
  }
```

**Do not touch the "Knockout weapon-steal offer" block that follows this** (`if (targetHealthAfter === 0) { ... }`, with the inline-button code) — it's unchanged and correctly fires for the "ass" outcome automatically, since `targetHealthAfter` is set to `0` by that branch the same way any other lethal hit sets it.

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the health-math (heal clamp and full-wipe floor) in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, max_health INTEGER NOT NULL DEFAULT 100)\`);

function damageHuman(userId, damage) {
  return db.prepare('UPDATE user_health SET health = MAX(0, health - ?) WHERE user_id = ? RETURNING health').get(damage, userId);
}

db.prepare('INSERT INTO user_health (user_id, health, max_health) VALUES (1, 90, 100)').run();
const before1 = db.prepare('SELECT health, max_health FROM user_health WHERE user_id = 1').get();
const after1 = Math.min(before1.max_health, before1.health + 20);
const healed1 = after1 - before1.health;
console.log('heal from 90 (capped):', after1, 'healed:', healed1, 'expected 100 healed 10');

db.prepare('INSERT INTO user_health (user_id, health, max_health) VALUES (2, 50, 100)').run();
const before2 = db.prepare('SELECT health, max_health FROM user_health WHERE user_id = 2').get();
const after2 = Math.min(before2.max_health, before2.health + 20);
const healed2 = after2 - before2.health;
console.log('heal from 50 (uncapped):', after2, 'healed:', healed2, 'expected 70 healed 20');

db.prepare('INSERT INTO user_health (user_id, health, max_health) VALUES (3, 37, 100)').run();
const before3 = db.prepare('SELECT health FROM user_health WHERE user_id = 3').get();
const after3 = damageHuman(3, before3.health);
console.log('ass full-wipe from 37:', after3.health, 'expected 0');

db.prepare('INSERT INTO user_health (user_id, health, max_health) VALUES (4, 0, 100)').run();
const before4 = db.prepare('SELECT health FROM user_health WHERE user_id = 4').get();
const after4 = damageHuman(4, before4.health);
console.log('ass full-wipe already at 0:', after4.health, 'expected 0');
"
```

Expected output (in order):
```
heal from 90 (capped): 100 healed: 10 expected 100 healed 10
heal from 50 (uncapped): 70 healed: 20 expected 70 healed 20
ass full-wipe from 37: 0 expected 0
ass full-wipe already at 0: 0 expected 0
```

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: implement carrot hole resolution, cat/fox status, and crit suppression in /kick"
git push
```

---

### Task 4: `/me` display special-case

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1053-1056` (the weapon-listing loop in `/me`)

**Note on line numbers:** Tasks 1-3 shifted lines earlier in the file. Locate by surrounding text.

- [ ] **Step 1: Special-case carrot in the weapon-display loop**

Find:

```js
  for (const row of getWeaponsFor('human', msg.from.id)) {
    const def = WEAPON_DEFS[row.weapon_key];
    lines.push(`${def.emoji} Ты держишь ${def.name}: урон ×${def.multiplier}`);
  }
```

Replace with:

```js
  for (const row of getWeaponsFor('human', msg.from.id)) {
    const def = WEAPON_DEFS[row.weapon_key];
    if (row.weapon_key === 'carrot') {
      lines.push(`${def.emoji} Ты держишь ${def.name}: случайное место попадания, от лечения до мгновенного нокаута`);
    } else {
      lines.push(`${def.emoji} Ты держишь ${def.name}: урон ×${def.multiplier}`);
    }
  }
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: special-case /me's weapon display for carrot"
git push
```

---

### Task 5: Manual end-to-end verification

**Files:** none (verification only, against the running bot — deploy is the user's own GitHub-based flow)

- [ ] **Step 1: Confirm `@MashaZaykaaa`'s weapon resolves**

Have her send any message in the chat (triggers the existing lazy-resolution UPDATE), then check `weapon_ownership` for `weapon_key = 'carrot'` on prod and confirm `owner_user_id`/`owner_username` are now populated.

- [ ] **Step 2: Land enough hits to observe all 5 holes**

Repeatedly `/kick` with the carrot equipped (or steal it first if it's changed hands) until each of the 5 outcomes has been seen at least once:
- **ear/nose/mouth:** confirm the damage math looks right (roughly 80%/90%/50% of a normal `/kick` hit) and the flavor message matches.
- **dick:** confirm NO damage is dealt, the target's health goes UP by up to 20 (capped at their max), and the "оргазм" message appears.
- **ass:** confirm the target's health goes to exactly 0, they get muted for 30 minutes (existing behavior), AND the knockout-steal-buttons offer appears (if they were holding a real weapon) — same as any other knockout.

- [ ] **Step 3: Confirm cat/fox status applies and expires**

After any successful carrot hit, confirm the victim gets tagged `/cat` or `/fox` (their next mat/swear word should get the corresponding sound reaction). Wait 20 minutes (or temporarily shorten the window via a direct `UPDATE animals SET animal_until = ...` on prod for faster testing) and confirm the status is gone afterward — no sound reaction, and the `animals` row is cleaned up.

- [ ] **Step 4: Confirm a permanent animal status isn't downgraded**

As admin, `/pig` someone (permanent). Have them get hit by the carrot. Expected: they're still a pig (not switched to a temporary cat/fox) — `SELECT animal, animal_until FROM animals WHERE user_id = <them>` on prod should still show `animal = 'pig'`, `animal_until = NULL`.

- [ ] **Step 5: Confirm crit is suppressed only on "ass"**

Over several hits, confirm that landing "ass" never also shows a "Критический удар!" injury message on that same hit, while ear/nose/mouth/dick hits can still independently crit as normal (injury message + possible weapon steal) when the underlying roll is high enough.

- [ ] **Step 6: Confirm `/me` shows the descriptive line**

As the carrot's current holder, run `/me` and confirm it shows `🥕 Ты держишь морковку: случайное место попадания, от лечения до мгновенного нокаута` instead of a numeric multiplier.

- [ ] **Step 7: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as the earlier tasks.
