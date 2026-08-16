# `/heal` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only `/heal` command that clears a patient's injury (arm/leg/head) and any active scissors bleed in one shot, reply-to-message targeting only.

**Architecture:** A single new `bot.onText` handler in `c:\Users\123\Projects\tg-bot\bot.js`, placed right after the existing `/cure` handler. Reuses the existing `isAdmin(msg)` and `resolveUser(msg)` helpers verbatim — no new helpers, no new schema. Reads/clears the existing `injuries` table and the existing `user_health.bleed_until`/`bleed_chat_id` columns (both already in production from earlier work this session).

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is manual (`node --check` for syntax, live smoke test), same as every other plan in this repo.

**Spec:** `docs/superpowers/specs/2026-08-16-heal-command-design.md`

---

### Task 1: Add the `/heal` command handler

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1451-1453` (insert new handler right after `/cure`, before `/endvirus`)

- [x] **Step 1: Insert the `/heal` handler between `/cure` and `/endvirus`**

Find:

```js
  db.prepare('UPDATE virus_infections SET immune = 1 WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM virus_procedures WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} вылечен от DedoVirus и получил иммунитет`, threadOpts(msg));
});

bot.onText(/\/endvirus\b/, async (msg) => {
```

Replace with:

```js
  db.prepare('UPDATE virus_infections SET immune = 1 WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM virus_procedures WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} вылечен от DedoVirus и получил иммунитет`, threadOpts(msg));
});

// Admin-only, reply-to-message targeting (same as /cure above) — clears
// both an arm/leg/head injury and an active scissors bleed in one shot.
// Deliberately doesn't touch health points or an active "драка" mute —
// those are a separate mechanic (health regen ticks on its own, mute
// expires on its own timer) and stay out of scope here. The DELETE/UPDATE
// below are harmless no-ops if the respective condition was already
// false, so there's no need to branch on each independently — only the
// "nothing to heal at all" case needs its own early return/message.
bot.onText(/\/heal\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  const injuryRow = db.prepare('SELECT injury_type FROM injuries WHERE user_id = ?').get(user.id);
  const bleedRow = db.prepare('SELECT bleed_until FROM user_health WHERE user_id = ?').get(user.id);
  const wasBleeding = bleedRow && bleedRow.bleed_until && bleedRow.bleed_until * 1000 > Date.now();

  if (!injuryRow && !wasBleeding) {
    return bot.sendMessage(msg.chat.id, `${user.username} и так здоров, лечить нечего`, threadOpts(msg));
  }

  db.prepare('DELETE FROM injuries WHERE user_id = ?').run(user.id);
  db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(user.id);

  const healed = [injuryRow && 'травма', wasBleeding && 'кровотечение'].filter(Boolean).join(' и ');
  bot.sendMessage(msg.chat.id, `${user.username} вылечен: ${healed}`, threadOpts(msg));
});

bot.onText(/\/endvirus\b/, async (msg) => {
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Verify the injury/bleed clearing logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE injuries (user_id INTEGER PRIMARY KEY, injury_type TEXT NOT NULL, injured_until INTEGER NOT NULL)\`);
db.exec(\`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, bleed_until INTEGER, bleed_chat_id INTEGER)\`);

const now = Math.floor(Date.now() / 1000);
db.prepare('INSERT INTO injuries (user_id, injury_type, injured_until) VALUES (1, ?, ?)').run('arm', now + 3600);
db.prepare('INSERT INTO user_health (user_id, health, bleed_until, bleed_chat_id) VALUES (1, 80, ?, 999)').run(now + 600);
db.prepare('INSERT INTO user_health (user_id, health) VALUES (2, 100)').run();

function healUser(userId) {
  const injuryRow = db.prepare('SELECT injury_type FROM injuries WHERE user_id = ?').get(userId);
  const bleedRow = db.prepare('SELECT bleed_until FROM user_health WHERE user_id = ?').get(userId);
  const wasBleeding = bleedRow && bleedRow.bleed_until && bleedRow.bleed_until * 1000 > Date.now();
  if (!injuryRow && !wasBleeding) return 'nothing to heal';
  db.prepare('DELETE FROM injuries WHERE user_id = ?').run(userId);
  db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(userId);
  return [injuryRow && 'травма', wasBleeding && 'кровотечение'].filter(Boolean).join(' и ');
}

console.log('user 1 (has both):', healUser(1));
console.log('user 1 row after:', db.prepare('SELECT * FROM injuries WHERE user_id = 1').get(), db.prepare('SELECT bleed_until, bleed_chat_id FROM user_health WHERE user_id = 1').get());
console.log('user 2 (has neither):', healUser(2));
"
```

Expected:
- `user 1 (has both):` `травма и кровотечение`
- `user 1 row after:` `undefined { bleed_until: null, bleed_chat_id: null }` (the injuries row is gone, `.get()` on it returns `undefined`)
- `user 2 (has neither):` `nothing to heal`

- [x] **Step 4: Commit and push**

```bash
git add bot.js
git commit -m "feat: add /heal admin command (clear injury + bleed)"
git push
```

---

### Task 2: Manual end-to-end verification

**Files:** none (verification only, against the running bot — deploy is the user's own GitHub-based flow)

- [x] **Step 1: Confirm the happy path**

Get someone injured and/or bleeding (e.g. via a few `/kick`s until a crit lands, or a scissors hit for bleed). As an admin, reply `/heal` to their message. Expected: a message naming exactly what was healed (`травма`, `кровотечение`, or `травма и кровотечение`), and their subsequent `/me` no longer shows the injury/bleed lines.

- [x] **Step 2: Confirm the "nothing to heal" case**

Reply `/heal` to a healthy user's message. Expected: `<user> и так здоров, лечить нечего`.

- [x] **Step 3: Confirm admin-only enforcement**

Have a non-admin reply `/heal` to someone. Expected: silent no-op, no message at all (matching `/cure`'s own behavior for non-admins).

- [x] **Step 4: Confirm the no-reply case**

Send `/heal` without replying to anyone. Expected: `Ответь на сообщение`.

- [x] **Step 5: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as Task 1.
