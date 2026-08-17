# Kuni Success Roll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 50/50 success roll to each of the three already-live `/kuniFun`, `/kuniAlia`, `/kuniTama` commands — on failure, no buff is granted (but the cooldown still starts) and a "не вышло" message is sent instead.

**Architecture:** Each of the three existing `bot.onText` handlers in `c:\Users\123\Projects\tg-bot\bot.js` gets a roll inserted between the existing cooldown check and the existing buff-insert. On failure (`roll < 50`), a narrower `INSERT ... ON CONFLICT DO UPDATE` writes only that command's own `*_cd_until` column (leaving any already-active buff from an earlier success untouched) and the handler returns early with a failure message. On success, the existing insert/message logic is unchanged except the roll number is appended to the flavor message.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is `node --check` for syntax plus isolated `node -e` scripts against a scratch in-memory DB, then a live smoke test, matching every other plan in this repo.

**Spec:** `docs/superpowers/specs/2026-08-16-kuni-buffs-design.md` (see "Success roll (50/50)" and updated "Commands" sections)

---

### Task 1: Add the success roll to `/kuniFun`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1152-1166`

- [ ] **Step 1: Replace the `/kuniFun` handler**

Find:

```js
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
```

Replace with:

```js
bot.onText(/\/kuniFun\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT fun_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.fun_cd_until > now) {
    const minutesLeft = Math.ceil((row.fun_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  const until = now + 600;
  const roll = Math.floor(Math.random() * 101);
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, fun_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET fun_cd_until = excluded.fun_cd_until'
    ).run(msg.from.id, until);
    return bot.sendMessage(msg.chat.id, `${actorLabel} попытался сделать куни InternalFun, но не вышло 😅 (${roll}/100)`, threadOpts(msg));
  }
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, fun_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.5, crit_until = excluded.crit_until, fun_cd_until = excluded.fun_cd_until'
  ).run(msg.from.id, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни InternalFun и теперь стал более опасен ⚡ (+крит на 10 мин): ${roll}/100`, threadOpts(msg));
});
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the roll branching logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE buffs (user_id INTEGER PRIMARY KEY, crit_mult REAL, crit_until INTEGER, dodge_mult REAL, dodge_until INTEGER, fun_cd_until INTEGER, alia_cd_until INTEGER, tama_cd_until INTEGER)\`);

function castFun(userId, roll) {
  const now = Math.floor(Date.now() / 1000);
  const until = now + 600;
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, fun_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET fun_cd_until = excluded.fun_cd_until'
    ).run(userId, until);
    return 'fail';
  }
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, fun_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.5, crit_until = excluded.crit_until, fun_cd_until = excluded.fun_cd_until'
  ).run(userId, until, until);
  return 'success';
}

console.log('roll 30 (fail):', castFun(1, 30), 'expected fail');
console.log('row after fail:', db.prepare('SELECT crit_mult, crit_until FROM buffs WHERE user_id = 1').get(), 'expected { crit_mult: null, crit_until: null }');

console.log('roll 70 (success):', castFun(2, 70), 'expected success');
console.log('row after success:', db.prepare('SELECT crit_mult FROM buffs WHERE user_id = 2').get(), 'expected { crit_mult: 1.5 }');

castFun(3, 70);
console.log('user 3 active crit_mult before failed re-cast:', db.prepare('SELECT crit_mult FROM buffs WHERE user_id = 3').get().crit_mult, 'expected 1.5');
castFun(3, 20);
console.log('user 3 active crit_mult after failed re-cast:', db.prepare('SELECT crit_mult FROM buffs WHERE user_id = 3').get().crit_mult, 'expected 1.5 (unchanged, buff not cleared by a failed re-cast)');
"
```

Expected output (in order):
```
roll 30 (fail): fail expected fail
row after fail: { crit_mult: null, crit_until: null } expected { crit_mult: null, crit_until: null }
roll 70 (success): success expected success
row after success: { crit_mult: 1.5 } expected { crit_mult: 1.5 }
user 3 active crit_mult before failed re-cast: 1.5 expected 1.5
user 3 active crit_mult after failed re-cast: 1.5 expected 1.5 (unchanged, buff not cleared by a failed re-cast)
```

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add 50/50 success roll to /kuniFun"
git push
```

---

### Task 2: Add the success roll to `/kuniAlia`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1168-1182`

- [ ] **Step 1: Replace the `/kuniAlia` handler**

Find:

```js
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
```

Replace with:

```js
bot.onText(/\/kuniAlia\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT alia_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.alia_cd_until > now) {
    const minutesLeft = Math.ceil((row.alia_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  const until = now + 600;
  const roll = Math.floor(Math.random() * 101);
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, alia_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET alia_cd_until = excluded.alia_cd_until'
    ).run(msg.from.id, until);
    return bot.sendMessage(msg.chat.id, `${actorLabel} попытался сделать куни AliyaKuzAli, но не вышло 😅 (${roll}/100)`, threadOpts(msg));
  }
  db.prepare(
    'INSERT INTO buffs (user_id, dodge_mult, dodge_until, alia_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dodge_mult = 1.5, dodge_until = excluded.dodge_until, alia_cd_until = excluded.alia_cd_until'
  ).run(msg.from.id, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни AliyaKuzAli и теперь лучше уклоняется 🌀 (+уклонение на 10 мин): ${roll}/100`, threadOpts(msg));
});
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the roll branching logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE buffs (user_id INTEGER PRIMARY KEY, crit_mult REAL, crit_until INTEGER, dodge_mult REAL, dodge_until INTEGER, fun_cd_until INTEGER, alia_cd_until INTEGER, tama_cd_until INTEGER)\`);

function castAlia(userId, roll) {
  const now = Math.floor(Date.now() / 1000);
  const until = now + 600;
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, alia_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET alia_cd_until = excluded.alia_cd_until'
    ).run(userId, until);
    return 'fail';
  }
  db.prepare(
    'INSERT INTO buffs (user_id, dodge_mult, dodge_until, alia_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dodge_mult = 1.5, dodge_until = excluded.dodge_until, alia_cd_until = excluded.alia_cd_until'
  ).run(userId, until, until);
  return 'success';
}

console.log('roll 10 (fail):', castAlia(1, 10), 'expected fail');
console.log('row after fail:', db.prepare('SELECT dodge_mult, dodge_until FROM buffs WHERE user_id = 1').get(), 'expected { dodge_mult: null, dodge_until: null }');

console.log('roll 90 (success):', castAlia(2, 90), 'expected success');
console.log('row after success:', db.prepare('SELECT dodge_mult FROM buffs WHERE user_id = 2').get(), 'expected { dodge_mult: 1.5 }');

castAlia(3, 90);
castAlia(3, 5);
console.log('user 3 active dodge_mult after failed re-cast:', db.prepare('SELECT dodge_mult FROM buffs WHERE user_id = 3').get().dodge_mult, 'expected 1.5 (unchanged)');
"
```

Expected output (in order):
```
roll 10 (fail): fail expected fail
row after fail: { dodge_mult: null, dodge_until: null } expected { dodge_mult: null, dodge_until: null }
roll 90 (success): success expected success
row after success: { dodge_mult: 1.5 } expected { dodge_mult: 1.5 }
user 3 active dodge_mult after failed re-cast: 1.5 expected 1.5 (unchanged)
```

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add 50/50 success roll to /kuniAlia"
git push
```

---

### Task 3: Add the success roll to `/kuniTama`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1184-1198`

- [ ] **Step 1: Replace the `/kuniTama` handler**

Find:

```js
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
```

Replace with:

```js
bot.onText(/\/kuniTama\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT tama_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.tama_cd_until > now) {
    const minutesLeft = Math.ceil((row.tama_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  const until = now + 600;
  const roll = Math.floor(Math.random() * 101);
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, tama_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET tama_cd_until = excluded.tama_cd_until'
    ).run(msg.from.id, until);
    return bot.sendMessage(msg.chat.id, `${actorLabel} попытался сделать куни Tama, но не вышло 😅 (${roll}/100)`, threadOpts(msg));
  }
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, dodge_mult, dodge_until, tama_cd_until) VALUES (?, 1.25, ?, 1.25, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.25, crit_until = excluded.crit_until, dodge_mult = 1.25, dodge_until = excluded.dodge_until, tama_cd_until = excluded.tama_cd_until'
  ).run(msg.from.id, until, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни Tama и теперь стал опаснее и увёртливее ✨ (+крит и +уклонение на 10 мин): ${roll}/100`, threadOpts(msg));
});
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the roll branching logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE buffs (user_id INTEGER PRIMARY KEY, crit_mult REAL, crit_until INTEGER, dodge_mult REAL, dodge_until INTEGER, fun_cd_until INTEGER, alia_cd_until INTEGER, tama_cd_until INTEGER)\`);

function castTama(userId, roll) {
  const now = Math.floor(Date.now() / 1000);
  const until = now + 600;
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, tama_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET tama_cd_until = excluded.tama_cd_until'
    ).run(userId, until);
    return 'fail';
  }
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, dodge_mult, dodge_until, tama_cd_until) VALUES (?, 1.25, ?, 1.25, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.25, crit_until = excluded.crit_until, dodge_mult = 1.25, dodge_until = excluded.dodge_until, tama_cd_until = excluded.tama_cd_until'
  ).run(userId, until, until, until);
  return 'success';
}

console.log('roll 0 (fail):', castTama(1, 0), 'expected fail');
console.log('row after fail:', db.prepare('SELECT crit_mult, dodge_mult FROM buffs WHERE user_id = 1').get(), 'expected { crit_mult: null, dodge_mult: null }');

console.log('roll 100 (success):', castTama(2, 100), 'expected success');
console.log('row after success:', db.prepare('SELECT crit_mult, dodge_mult FROM buffs WHERE user_id = 2').get(), 'expected { crit_mult: 1.25, dodge_mult: 1.25 }');

castTama(3, 100);
castTama(3, 49);
console.log('user 3 active mults after failed re-cast:', db.prepare('SELECT crit_mult, dodge_mult FROM buffs WHERE user_id = 3').get(), 'expected { crit_mult: 1.25, dodge_mult: 1.25 } (unchanged)');
"
```

Expected output (in order):
```
roll 0 (fail): fail expected fail
row after fail: { crit_mult: null, dodge_mult: null } expected { crit_mult: null, dodge_mult: null }
roll 100 (success): success expected success
row after success: { crit_mult: 1.25, dodge_mult: 1.25 } expected { crit_mult: 1.25, dodge_mult: 1.25 }
user 3 active mults after failed re-cast: { crit_mult: 1.25, dodge_mult: 1.25 } expected { crit_mult: 1.25, dodge_mult: 1.25 } (unchanged)
```

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add 50/50 success roll to /kuniTama"
git push
```

---

### Task 4: Manual end-to-end verification

**Files:** none (verification only, against the running bot — deploy is the user's own GitHub-based flow)

- [ ] **Step 1: Confirm a failure**

Run `/kuniFun` (or `/kuniAlia`/`/kuniTama`) repeatedly (different users, or wait out cooldowns) until a failure lands. Expected: `<user> попытался сделать куни <name>, но не вышло 😅 (N/100)` with `N < 50`, and the buff does NOT apply — check via `/kick` that crit/dodge rates look unbuffed, or simply note no success flavor line appeared.

- [ ] **Step 2: Confirm the failed attempt still started the cooldown**

Immediately re-run the same command after a failure. Expected: `<user>, бафф уже активен (ещё N мин).` — same cooldown-block message as a successful cast would produce, confirming failure still consumes the 10-minute window.

- [ ] **Step 3: Confirm a success**

Once a success lands (roll >= 50). Expected: the existing flavor message, now with `: N/100` appended (`N >= 50`), and the buff applies as before — verify via `/kick` that crit/dodge rates look elevated, same as prior to this change.

- [ ] **Step 4: Confirm a failed re-cast doesn't clear an active buff**

Cast a command successfully, then (once its cooldown naturally would allow — or by testing with a second account/different command's independent cooldown) confirm that if a retry can somehow occur while a buff is still flagged active, an already-active buff isn't wiped by a later failed attempt. In practice this is hard to trigger live since a success and its own cooldown expire together — this is primarily covered by Task 1-3's isolated verification scripts (user 3 in each), so a live re-check here is optional if time-constrained.

- [ ] **Step 5: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as the earlier tasks.
