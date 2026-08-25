# Платная больничка Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Больничка entry costs the victim 1 coin; without it, the old flat 30-minute knockout mute (`isKnockedOut`, deleted when больничка originally shipped) is revived as a fallback. Больничка's existing attack-to-leave-early mechanic now requires ≥5 HP.

**Architecture:** `damageHuman` tries a guarded coin debit before deciding which of the two knockout-handling paths to take. `performKick` re-derives which path was taken via `isHospitalized(target.id)` (no signature change to `damageHuman` needed) to pick the right announcement, and gains two new attacker-side hard blocks (revived `isKnockedOut`, and a new ≥5 HP gate) alongside its existing checks.

**Tech Stack:** Node.js, `node-telegram-bot-api`, `better-sqlite3`, single file `bot.js`.

---

## Spec

Full design: `docs/superpowers/specs/2026-08-25-paid-hospital-design.md`. Read it before starting.

## Existing code this plan builds on (verified current line numbers — re-locate by searching if drifted)

- `muteUser(userId, chatId, username, byId, byName, durationMs)` — `bot.js:920` — already exists, untouched, still used by the real `/mute` admin command. This plan adds a NEW call to it (reviving the old knockout-mute call site), not a new definition.
- `damageHuman(userId, chatId, username, damage)` — `bot.js:1353-1364`. The `if (row.health === 0) { ... }` block (`1357-1362`) is what changes.
- `HOSPITAL_EXIT_HEALTH`/`HOSPITAL_REGEN_MULTIPLIER` constants — `bot.js:1166-1167` — the new `HOSPITAL_MIN_DISCHARGE_HEALTH` constant goes right after these.
- `isHidden(userId)` — `bot.js:1315` — just for reference on file layout; not modified.
- `performKick`'s target-side больничка block (`isHospitalized(target.id)`, `bot.js:2036-2039`) and the line right after it, `const attackerHealth = getUserHealth(attacker.id);` (`bot.js:2041`) — both new attacker-side hard blocks (revived `isKnockedOut`, new ≥5 HP gate) go immediately after `2041`, before the existing `isStunned` check (`2042-2047`).
- The knockout-loot block's announcement (`bot.js:2325-2333`, inside `if (targetHealthAfter === 0) { ... }`) — becomes conditional on `isHospitalized(target.id)`.
- The `isMuted` branch's stale comment in the main message handler (`bot.js:3057-3063`, search `only ever reached via a troll-bot-caused`) — needs updating since it's about to become inaccurate again.

No schema changes — `coins`, `hospitalized_since`, and the `mutes` table all already exist. No troll-bot changes.

---

### Task 1: `damageHuman` coin-gate + revived `isKnockedOut` + `HOSPITAL_MIN_DISCHARGE_HEALTH` constant

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the `HOSPITAL_MIN_DISCHARGE_HEALTH` constant**

Find (`bot.js:1166-1167`):

```js
const HOSPITAL_EXIT_HEALTH = 30;      // больничка releases you once health reaches this
const HOSPITAL_REGEN_MULTIPLIER = 2;  // regen rate while hospitalized, vs. the normal HEALTH_REGEN_PER_HOUR baseline
```

Replace with:

```js
const HOSPITAL_EXIT_HEALTH = 30;      // больничка releases you once health reaches this
const HOSPITAL_REGEN_MULTIPLIER = 2;  // regen rate while hospitalized, vs. the normal HEALTH_REGEN_PER_HOUR baseline
const HOSPITAL_MIN_DISCHARGE_HEALTH = 5; // minimum health to leave больничка early by attacking
```

- [ ] **Step 2: Coin-gate больничка entry in `damageHuman`**

Find (`bot.js:1357-1362`):

```js
  if (row.health === 0) {
    // COALESCE: re-flooring an already-hospitalized player to 0 again
    // (e.g. a second hit landing before they've regenerated at all)
    // must not reset their entry timestamp.
    db.prepare('UPDATE user_health SET hospitalized_since = COALESCE(hospitalized_since, ?) WHERE user_id = ?').run(now, userId);
  }
```

Replace with:

```js
  if (row.health === 0) {
    // Больничка costs 1 coin to enter — can't pay, don't get admitted.
    // No coins means the guarded UPDATE below matches 0 rows (paid is
    // falsy), same as a missing pvp_stats row entirely (shouldn't
    // happen in practice — reaching 0 HP always implies a warrior, who
    // always has a row — but handled safely regardless).
    const paid = db.prepare('UPDATE pvp_stats SET coins = coins - 1 WHERE user_id = ? AND coins >= 1 RETURNING coins').get(userId);
    if (paid) {
      // COALESCE: re-flooring an already-hospitalized player to 0 again
      // (e.g. a second hit landing before they've regenerated at all)
      // must not reset their entry timestamp.
      db.prepare('UPDATE user_health SET hospitalized_since = COALESCE(hospitalized_since, ?) WHERE user_id = ?').run(now, userId);
    } else {
      muteUser(userId, chatId, username, 0, 'драка', 30 * 60 * 1000);
    }
  }
```

- [ ] **Step 3: Revive `isKnockedOut`**

Insert immediately before `damageHuman`'s own doc comment (search for `// tick's own concurrent writes (see healthRegenTick below)`, which is the last line of `damageHuman`'s preceding comment block — insert right before that comment block starts, i.e. before its first line `// UPDATE...RETURNING keeps the floor-then-read atomic...`):

```js
// Whether an attacker is still within their post-knockout mute (see
// damageHuman's muteUser(..., 'драка', 30 min) call below — only
// reached when больничка couldn't be paid for, see
// docs/superpowers/specs/2026-08-25-paid-hospital-design.md). /kick
// used to gate on health === 0 directly, but healthRegenTick's hourly
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

- [ ] **Step 4: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_paidhospital1.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE pvp_stats (user_id INTEGER PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, hospitalized_since INTEGER)`);
db.exec(`CREATE TABLE mutes (user_id INTEGER PRIMARY KEY, chat_id INTEGER, username TEXT, muted_by INTEGER, muted_by_name TEXT, expires_at INTEGER)`);

function isKnockedOut(userId) {
  const row = db.prepare('SELECT muted_by_name, expires_at FROM mutes WHERE user_id = ?').get(userId);
  if (!row || row.muted_by_name !== 'драка') return false;
  if (row.expires_at && row.expires_at * 1000 < Date.now()) {
    db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
    return false;
  }
  return true;
}
function muteUser(userId, chatId, username, byId, byName, durationMs) {
  const expiresAt = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
  db.prepare(
    'INSERT OR REPLACE INTO mutes (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, chatId, username, byId, byName, expiresAt);
}

function handleKnockout(userId, chatId, username, now) {
  const paid = db.prepare('UPDATE pvp_stats SET coins = coins - 1 WHERE user_id = ? AND coins >= 1 RETURNING coins').get(userId);
  if (paid) {
    db.prepare('UPDATE user_health SET hospitalized_since = COALESCE(hospitalized_since, ?) WHERE user_id = ?').run(now, userId);
    return 'hospitalized';
  } else {
    muteUser(userId, chatId, username, 0, 'драка', 30 * 60 * 1000);
    return 'muted';
  }
}

// Warrior with a coin: gets hospitalized, coin spent
db.prepare('INSERT INTO pvp_stats (user_id, coins) VALUES (1, 3)').run();
db.prepare('INSERT INTO user_health (user_id, hospitalized_since) VALUES (1, NULL)').run();
console.log('outcome (has coins):', handleKnockout(1, -100, 'alice', 1000), 'expected hospitalized');
console.log('coins after (3-1):', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=1').get(), 'expected {coins: 2}');
console.log('hospitalized_since set:', db.prepare('SELECT hospitalized_since FROM user_health WHERE user_id=1').get(), 'expected {hospitalized_since: 1000}');
console.log('isKnockedOut for warrior 1 (should be false, they were hospitalized not muted):', isKnockedOut(1), 'expected false');

// Warrior with 0 coins: old mute applies, not hospitalized
db.prepare('INSERT INTO pvp_stats (user_id, coins) VALUES (2, 0)').run();
db.prepare('INSERT INTO user_health (user_id, hospitalized_since) VALUES (2, NULL)').run();
console.log('outcome (no coins):', handleKnockout(2, -100, 'bob', 2000), 'expected muted');
console.log('coins after (unchanged at 0):', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=2').get(), 'expected {coins: 0}');
console.log('hospitalized_since still null:', db.prepare('SELECT hospitalized_since FROM user_health WHERE user_id=2').get(), 'expected {hospitalized_since: null}');
console.log('isKnockedOut for warrior 2 (should be true, old mute applied):', isKnockedOut(2), 'expected true');

// Missing pvp_stats row entirely: behaves same as 0 coins
console.log('outcome (no pvp_stats row):', handleKnockout(999, -100, 'ghost', 3000), 'expected muted');
console.log('isKnockedOut for ghost user (should be true):', isKnockedOut(999), 'expected true');

// isKnockedOut expiry: an already-expired mute self-deletes and reads false
db.prepare("INSERT OR REPLACE INTO mutes (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES (3, -100, 'carol', 0, 'драка', 500)").run();
console.log('isKnockedOut for expired mute:', isKnockedOut(3), 'expected false');
console.log('expired mute row deleted:', db.prepare('SELECT 1 FROM mutes WHERE user_id = 3').get(), 'expected undefined');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_paidhospital1.js`

Expected output (must match exactly):
```
outcome (has coins): hospitalized expected hospitalized
coins after (3-1): { coins: 2 } expected {coins: 2}
hospitalized_since set: { hospitalized_since: 1000 } expected {hospitalized_since: 1000}
isKnockedOut for warrior 1 (should be false, they were hospitalized not muted): false expected false
outcome (no coins): muted expected muted
coins after (unchanged at 0): { coins: 0 } expected {coins: 0}
hospitalized_since still null: { hospitalized_since: null } expected {hospitalized_since: null}
isKnockedOut for warrior 2 (should be true, old mute applied): true expected true
outcome (no pvp_stats row): muted expected muted
isKnockedOut for ghost user (should be true): true expected true
isKnockedOut for expired mute: false expected false
expired mute row deleted: undefined expected undefined
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_paidhospital1.js`

- [ ] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat: charge 1 coin for больничка entry, revive isKnockedOut as no-coins fallback"
```

Then push (this repo commits straight to main, no worktree, pushes immediately per standing project convention).

---

### Task 2: `performKick` — attacker hard-blocks + conditional knockout announcement

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the two new attacker-side hard blocks**

Find (`bot.js:2041-2042`):

```js
  const attackerHealth = getUserHealth(attacker.id);
  if (isStunned(attacker.id)) {
```

Replace with:

```js
  const attackerHealth = getUserHealth(attacker.id);
  if (isKnockedOut(attacker.id)) {
    bot.sendMessage(chatId, `${actorLabel}, твоя в отключке, какая драка!`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isHospitalized(attacker.id) && attackerHealth.health < HOSPITAL_MIN_DISCHARGE_HEALTH) {
    bot.sendMessage(chatId, `${actorLabel}, слишком слаб для драки — нужно хотя бы ${HOSPITAL_MIN_DISCHARGE_HEALTH} ХП, чтобы выписаться из больнички.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isStunned(attacker.id)) {
```

(The existing больничка attacker-side auto-break further down, right before `consumeEnergy(attacker.id)`, needs no change — by the time execution reaches it, this new gate has already guaranteed any still-hospitalized attacker has ≥ `HOSPITAL_MIN_DISCHARGE_HEALTH`.)

- [ ] **Step 2: Make the knockout announcement conditional**

Find (`bot.js:2325-2333`):

```js
  if (targetHealthAfter === 0) {
    // Announced unconditionally — the steal-offer message below only
    // fires when the victim actually holds a weapon, which used to mean
    // a weaponless knockout produced no chat message at all.
    await bot.sendMessage(
      chatId,
      `🏥 ${targetLabel} без сознания и попадает в больничку — недоступен для удара, пока не наберёт ${HOSPITAL_EXIT_HEALTH} ХП (или сам не решит атаковать раньше).`,
      threadOpts(msgLike)
    ).catch(() => {});
```

Replace with:

```js
  if (targetHealthAfter === 0) {
    // damageHuman already decided (and paid for, or didn't) больничка
    // entry — isHospitalized(target.id) here just reads back which of
    // its two branches actually fired, no re-deciding.
    if (isHospitalized(target.id)) {
      await bot.sendMessage(
        chatId,
        `🏥 ${targetLabel} без сознания и попадает в больничку (−1 монета из кошелька) — недоступен для удара, пока не наберёт ${HOSPITAL_EXIT_HEALTH} ХП (или сам не решит атаковать раньше, если наберётся хотя бы ${HOSPITAL_MIN_DISCHARGE_HEALTH} ХП).`,
        threadOpts(msgLike)
      ).catch(() => {});
    } else {
      await bot.sendMessage(
        chatId,
        `😵 ${targetLabel} без сознания, но денег на больничку нет — остаётся на улице, замьючен(а) на 30 мин (не может атаковать).`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
```

(The rest of the block — the weapon/coin loot-offer logic — is unchanged; leave it exactly as-is, still gated purely on `targetHealthAfter === 0`, independent of which message above fired.)

- [ ] **Step 3: Fix the now-stale `isMuted` comment**

Find (`bot.js:3057-3063`, search `only ever reached via a troll-bot-caused`):

```js
    // Knocked out by "Драка" (0 health) gets its own flavor line instead of
    // the normal admin-mute message — same underlying mute mechanism either
    // way, see muteUser/isMuted above. tg-bot's own /kick no longer ever
    // writes this mute (больничка replaced it, see hospitalized_since) —
    // this branch is now only ever reached via a troll-bot-caused
    // knockout, which still writes a 'драка' mute of its own into this
    // same shared table.
```

Replace with:

```js
    // Knocked out by "Драка" (0 health) gets its own flavor line instead of
    // the normal admin-mute message — same underlying mute mechanism either
    // way, see muteUser/isMuted above. Reached both via a troll-bot-caused
    // knockout AND via tg-bot's own /kick when больничка couldn't be paid
    // for (see docs/superpowers/specs/2026-08-25-paid-hospital-design.md
    // and damageHuman's isKnockedOut fallback) — either source writes the
    // same 'драка' mute into this same shared table.
```

- [ ] **Step 4: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: performKick attacker hard-blocks + conditional knockout announcement"
```

Then push.

---

### Task 3: Manual verification (left to user)

Not automated. After both tasks are pushed and the user restarts the bot (`pm2 restart tg-bot`), verify manually in the "Поединки" arena chat:

- [ ] Knock out a warrior WITH ≥1 coin → confirm "🏥 ... попадает в больничку (−1 монета...)" message, `/wallet` shows one less coin, больничка status appears in `/me`/`/find` as before.
- [ ] Knock out a warrior with 0 coins → confirm "😵 ... денег на больничку нет — остаётся на улице..." message, NO больничка status in `/me`/`/find`, and they're muted (messages get deleted with the "😵 X находится в отключке..." flavor text).
- [ ] The 0-coin muted victim tries `/kick` during their 30-min mute → confirm "твоя в отключке, какая драка!" refusal (revived hard block).
- [ ] Wait out (or otherwise clear) the 30-min mute → confirm the old-mute victim can `/kick` normally again.
- [ ] A hospitalized (paid-for) player with < 5 HP tries `/kick` → confirm "слишком слаб для драки — нужно хотя бы 5 ХП" refusal, больничка status untouched.
- [ ] A hospitalized player who regenerates to ≥ 5 HP (but still < 30) tries `/kick` → confirm the attack proceeds AND the existing "🏥 ... выписывается из больнички, чтобы напасть!" auto-break message still fires.
- [ ] Knockout-loot offer (weapon/coin theft buttons) still appears normally regardless of which knockout path (больничка vs old mute) fired, as long as the victim holds a weapon or has coins.
- [ ] A warrior with exactly 1 coin gets knocked out → confirm they're hospitalized (not muted) and their balance drops to exactly 0 — then if knocked out again while at 0 coins (e.g. after leaving больничка and re-entering combat), confirm the SECOND knockout falls back to the old mute path.

---

## Self-Review

**Spec coverage:** coin-gated больничка entry in `damageHuman` (✅ Task 1), revived `isKnockedOut` (✅ Task 1), `HOSPITAL_MIN_DISCHARGE_HEALTH` constant (✅ Task 1), `performKick` attacker hard-blocks for both revived-mute and <5-HP cases (✅ Task 2), conditional knockout announcement (✅ Task 2), stale `isMuted` comment fix (✅ Task 2). No troll-bot changes anywhere (✅). No schema changes needed or made (✅ — `coins`/`hospitalized_since`/`mutes` all pre-exist).

**Placeholder scan:** No TBD/TODO; every step has complete code or an exact command with expected output.

**Type consistency:** `isKnockedOut(userId): boolean` matches its pre-больничка signature exactly (verified against git history, commit `c533ce7`), so nothing else in the file needs to change to accommodate its return. `damageHuman`'s own signature and return type (`number`, the resulting health) are completely unchanged — Task 2's `performKick` changes re-derive which knockout path fired via the pre-existing `isHospitalized(target.id)` read, not via any new return value, keeping every other `damageHuman` call site (bleedTick, the carrot branches, axe's shave, etc.) untouched.
