# Horns (Рога) Real Weapon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth real, stealable weapon ("рога", `×2` damage) owned by `@Tamasvi_Vamp` that appends a flavor line ("насадила на рога!") to the existing crit message on a critical hit only, working everywhere the other real weapons work.

**Architecture:** A `WEAPON_DEFS.horns` entry duplicated in both repos, a `weapon_ownership` seed row using the normal username-based lazy resolution (she has a public `@username`, unlike Дима), and one extra `if (weapon.key === 'horns')` line inserted into the existing crit branch (`roll >= 90`/`swing.roll >= 90`/`critRoll >= 90`) at each of the 6 combat call sites, right after that branch's existing injury message. No new table, no new helper function — this is strictly additive flavor text.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is `node --check` per repo, no isolated `node -e` scripts needed (there's no new branching logic to unit-test, only string insertion into existing, already-tested control flow), then a live smoke test.

**Spec:** `docs/superpowers/specs/2026-08-17-horns-weapon-design.md`

---

### Task 1: tg-bot — `WEAPON_DEFS`, seed row, and `/kick` wiring

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` — `WEAPON_DEFS` (currently ends at line 830, right after the `crutch` entry IF Task-1-of-the-crutch-plan already landed; otherwise right after `scissors` — locate by content, not line number, since this depends on whether the sibling crutch-weapon plan has been executed yet)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` — weapon_ownership seed rows (same caveat — locate by content)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1127-1145` — `/kick`'s crit branch

- [ ] **Step 1: Add the horns WEAPON_DEFS entry**

Read the current `WEAPON_DEFS` block in bot.js first — it will look like ONE of these two, depending on whether the crutch-weapon plan has already been executed in this session:

Find (if crutch has NOT landed yet):

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
  horns: { name: 'рога', instrumental: 'рогами', accusative: 'рога', multiplier: 2, emoji: '🐂' },
};
```

OR, Find (if crutch HAS already landed — has a `crutch:` line):

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
  crutch: { name: 'костыль', instrumental: 'костылём', accusative: 'костыль', multiplier: 1.25, emoji: '🩼' },
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
};
```

Either way, the end state must have all previously-existing entries plus a new `horns: { name: 'рога', instrumental: 'рогами', accusative: 'рога', multiplier: 2, emoji: '🐂' },` line.

- [ ] **Step 2: Add the horns weapon_ownership seed row**

Same two-variant situation — find whichever seed-row block currently exists (three lines ending in `...scissors...` only, or four lines ending in `...crutch...`) and add ONE new line after the last existing line:

```js
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('horns', 'Tamasvi_Vamp', 'human', NULL, NULL)").run();
```

(Unlike `crutch`, this uses the normal username-based lazy resolution — `Tamasvi_Vamp` has a public `@username`, so `owner_user_id`/`owner_username` start `NULL` and get filled in automatically the next time she sends a message, via the existing generic resolution `UPDATE weapon_ownership SET owner_user_id = ?, owner_username = ? WHERE seed_username = ? AND owner_type = 'human' AND owner_user_id IS NULL` already in this file — no new code needed for that part.)

- [ ] **Step 3: Add the horns flavor line to `/kick`'s crit branch**

Find:

```js
  if (roll >= getCritThreshold(msg.from.id)) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healHours = applyInjury(target.id, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      msg.chat.id,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healHours} ч).`,
      threadOpts(msg)
    ).catch(() => {});
    const stolenKey = maybeStealWeapon(target.id, { type: 'human', userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
```

Replace with:

```js
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
```

(If the crutch-weapon plan already added its own block somewhere in this handler, it lives elsewhere — right after the earlier `scissors` block, which is a completely separate branch from this crit branch — so it does not interfere with this Find/Replace.)

- [ ] **Step 4: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: add horns weapon (crit flavor) to WEAPON_DEFS, seed row, and /kick (tg-bot)"
git push
```

---

### Task 2: troll-bot — `WEAPON_DEFS` and seed row

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js` — weapon_ownership seed block inside the startup `try` (locate by content — three or four existing `tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership...` lines depending on whether the crutch plan already landed)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js` — `WEAPON_DEFS` (same two-variant situation as tg-bot's Task 1 Step 1 above)

- [ ] **Step 1: Add the horns weapon_ownership seed row**

Find the existing block (three or four lines) ending in:

```js
} catch (err) {
```

and insert, right before that `} catch (err) {` line:

```js
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('horns', 'Tamasvi_Vamp', 'human', NULL, NULL)").run();
```

- [ ] **Step 2: Add the horns WEAPON_DEFS entry**

Same two-variant Find/Replace as tg-bot's Task 1 Step 1 (identical block, this repo just uses `const WEAPON_DEFS = {` at its own location) — add:

```js
  horns: { name: 'рога', instrumental: 'рогами', accusative: 'рога', multiplier: 2, emoji: '🐂' },
```

as the last entry.

- [ ] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add horns weapon seed row and WEAPON_DEFS entry (troll-bot)"
git push
```

---

### Task 3: troll-bot `performFight` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2176-2185` (inside `performFight`, the `trollSwing.roll >= 90` crit branch)

- [ ] **Step 1: Add the horns flavor line to the crit branch**

In this call site the troll is the attacker and the human (`from`) is the victim of the troll's counter-swing (`trollWeapon` is what the TROLL is holding). The flavor line attributes the action to the troll ("Тролль насадил"), same as the existing weapon-steal message a few lines below already does for the troll's own actions ("Тролль отобрал...") rather than reusing a human-specific verb form.

Find:

```js
    if (trollSwing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(from.id, injuryType);
      await bot.sendMessage(chatId, `🤕 Критический удар! ${actorName(from)} получить травму: ${injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова'} (на ${healHours} ч).`).catch(() => {});
      const stolenKey = maybeStealWeapon(from.id, { type: 'troll' });
```

Replace with:

```js
    if (trollSwing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(from.id, injuryType);
      await bot.sendMessage(chatId, `🤕 Критический удар! ${actorName(from)} получить травму: ${injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова'} (на ${healHours} ч).`).catch(() => {});
      if (trollWeapon.key === 'horns') {
        await bot.sendMessage(chatId, `🐂 Тролль насадил ${actorName(from)} на рога!`).catch(() => {});
      }
      const stolenKey = maybeStealWeapon(from.id, { type: 'troll' });
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: apply horns weapon crit flavor in performFight (troll-bot)"
git push
```

---

### Task 4: troll-bot `performDrink` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2379-2388` (inside `performDrink`, the `critRoll >= 90` crit branch, inside its 3-swing `for` loop)

- [ ] **Step 1: Add the horns flavor line to the crit branch**

Note: in this loop, the weapon variable is `weapon` (re-picked each iteration), and the human being hit is `from` (the troll is the attacker, same attacker/victim relationship as `performFight` — this is the troll counter-attacking the human who challenged it to drink). Same naming fix as Task 3 applies: the flavor line should say "Тролль насадил", not attribute the action to `from` (the victim).

Find:

```js
      if (critRoll >= 90) {
        const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
        const healHours = applyInjury(from.id, injuryType);
        const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
        await bot.sendMessage(chatId, `🤕 Критический удар! ${actorName(from)} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
        const stolenKey = maybeStealWeapon(from.id, { type: 'troll' });
```

Replace with:

```js
      if (critRoll >= 90) {
        const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
        const healHours = applyInjury(from.id, injuryType);
        const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
        await bot.sendMessage(chatId, `🤕 Критический удар! ${actorName(from)} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
        if (weapon.key === 'horns') {
          await bot.sendMessage(chatId, `🐂 Тролль насадил ${actorName(from)} на рога!`).catch(() => {});
        }
        const stolenKey = maybeStealWeapon(from.id, { type: 'troll' });
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: apply horns weapon crit flavor in performDrink (troll-bot)"
git push
```

---

### Task 5: troll-bot `triggerDrunkAttack` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2708-2718` (inside `triggerDrunkAttack`, the `swing.roll >= 90` crit branch)

Note: here the TROLL is the attacker and `target`/`name` is the human victim (opposite relationship from Tasks 3-4, where the troll counter-attacked the challenger) — so this message correctly attributes the action to the troll, same "Тролль ..." phrasing as the existing weapon-steal line a few lines below in this same block, hitting `name` (the victim).

- [ ] **Step 1: Add the horns flavor line to the crit branch**

`triggerDrunkAttack` and `triggerFasAttack` (Task 6) have a BYTE-IDENTICAL crit block at two different locations in this file. Before applying this Find/Replace, confirm you're in `triggerDrunkAttack` by finding the unique anchor line `logAction(target.userId, target.username || target.firstName, 'drunk_attack');` earlier in the same function (that exact string, `'drunk_attack'`, only appears in this function) — the Find block below should be the occurrence that comes after that anchor line, not the other (`'fas_attack'`-anchored) occurrence.

Find:

```js
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
    const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
    }
  }
}

// Tiered category names [mild, medium, mean] — indexed the same way as getMischiefTier.
```

(That trailing `// Tiered category names...` comment line is the unique anchor that confirms this is `triggerDrunkAttack`'s occurrence, not `triggerFasAttack`'s — only include it in your Find if your edit tool needs it for uniqueness; the `logAction(..., 'drunk_attack')` line earlier in the function is the more direct way to confirm you're in the right function before editing.)

Replace with:

```js
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
    if (weapon.key === 'horns') {
      bot.sendMessage(chatId, `🐂 Тролль насадил ${name} на рога!`).catch(() => {});
    }
    const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
    }
  }
}

// Tiered category names [mild, medium, mean] — indexed the same way as getMischiefTier.
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify only `triggerDrunkAttack` was touched, not `triggerFasAttack`**

Run: `grep -n "weapon.key === 'horns'" bot.js`
Expected: exactly ONE match so far, inside `triggerDrunkAttack`. (Task 6 will add the second.)

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: apply horns weapon crit flavor in triggerDrunkAttack (troll-bot)"
git push
```

---

### Task 6: troll-bot `triggerFasAttack` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2785-2795` (inside `triggerFasAttack`, the `swing.roll >= 90` crit branch)

- [ ] **Step 1: Add the horns flavor line to the crit branch**

This is the SECOND occurrence of the byte-identical crit block described in Task 5. Confirm you're editing the occurrence preceded earlier in its function by `logAction(target.userId, target.username || target.firstName, 'fas_attack');` (not `'drunk_attack'`, which is Task 5's and should already show a horns block from the previous task).

Find:

```js
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
    const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
    }
  }
}

function triggerMischief(chatId) {
```

(That trailing `function triggerMischief(chatId) {` line is the unique anchor confirming this is `triggerFasAttack`'s occurrence.)

Replace with:

```js
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
    if (weapon.key === 'horns') {
      bot.sendMessage(chatId, `🐂 Тролль насадил ${name} на рога!`).catch(() => {});
    }
    const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
    }
  }
}

function triggerMischief(chatId) {
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify both call sites now have the horns block**

Run: `grep -n "weapon.key === 'horns'" bot.js`
Expected: exactly TWO matches now (Task 5's in `triggerDrunkAttack`, this task's in `triggerFasAttack`).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: apply horns weapon crit flavor in triggerFasAttack (troll-bot)"
git push
```

---

### Task 7: troll-bot `triggerFoodSteal` wiring

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2922-2932` (inside `triggerFoodSteal`, the `swing.roll >= 90` crit branch, inside its `for` loop)

- [ ] **Step 1: Add the horns flavor line to the crit branch**

Find:

```js
    if (swing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(target.userId, injuryType);
      const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
      await bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
      const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
      if (stolenKey) {
        const stolenDef = WEAPON_DEFS[stolenKey];
        await bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
      }
    }
```

Replace with:

```js
    if (swing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(target.userId, injuryType);
      const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
      await bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
      if (weapon.key === 'horns') {
        await bot.sendMessage(chatId, `🐂 Тролль насадил ${name} на рога!`).catch(() => {});
      }
      const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
      if (stolenKey) {
        const stolenDef = WEAPON_DEFS[stolenKey];
        await bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
      }
    }
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify all 5 troll-bot call sites now have the horns block**

Run: `grep -n "weapon.key === 'horns'\|trollWeapon.key === 'horns'" bot.js`
Expected: exactly FIVE matches now (`performFight`, `performDrink`, `triggerDrunkAttack`, `triggerFasAttack`, `triggerFoodSteal`).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: apply horns weapon crit flavor in triggerFoodSteal (troll-bot)"
git push
```

---

### Task 8: Manual end-to-end verification

**Files:** none (verification only, against the running bots — deploy is the user's own GitHub-based flow, both repos)

- [ ] **Step 1: Confirm `@Tamasvi_Vamp`'s weapon resolves**

Have her send any message in the chat (triggers the existing lazy-resolution UPDATE), then check `weapon_ownership` for `weapon_key = 'horns'` on prod and confirm `owner_user_id`/`owner_username` are now populated (no longer NULL).

- [ ] **Step 2: Confirm `/kick` crit flavor**

Have her `/kick` someone enough times to land a crit (roll >= the crit threshold — may take a few tries; kuni-buffs crit-chance buffs can shorten this if active). Expected: the existing injury message, then `🐂 {actorLabel} насадила {targetLabel} на рога!`, then (5% of the time via the existing independent weapon-steal roll) the existing steal message — all three as separate messages in the expected order.

- [ ] **Step 3: Confirm non-crit hits show nothing extra**

A non-crit successful hit with horns should show only the normal damage message — no horns flavor line, confirming the crit gate works.

- [ ] **Step 4: Confirm troll-bot behavior if horns changes hands**

If horns gets stolen (5% chance on any crit, existing mechanic) by the troll or another human, confirm the new holder's crits also show the appropriate flavor line — "Тролль насадил ..." if the troll holds it, or the same "{actorLabel} насадила ..." line if another human holds it (via `/kick`, tg-bot side).

- [ ] **Step 5: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as the earlier tasks (in whichever repo needed the fix).
