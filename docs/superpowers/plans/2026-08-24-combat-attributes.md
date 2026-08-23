# Combat Attributes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/kick`'s full-refusal injury block and single hit roll with four persistent per-fighter attributes (точность/сила/ловкость/выносливость), targeted -10% injury penalties, a second independent dodge roll, an XP/leveling system with a new `/levelup` command, and a 20-minute post-hit чулан lockout.

**Architecture:** Five new columns on the existing `pvp_stats` table (no new table). `performKick` gets a full internal rewrite of its hit-resolution section — the surrounding structure (target checks, weapon pick, damage-calc branches, weapon side effects, knockout offer) stays intact. `healthRegenTick`'s energy loop gains a per-user interval via a `LEFT JOIN` against `pvp_stats`. Everything is additive/formula-driven — no existing column is repurposed, no existing table is dropped.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. Verification: `node --check` for syntax, isolated `node -e` scripts against scratch in-memory DBs for every formula (available-points math, dodge/threshold clamps, per-user regen interval, strength/injury damage multiplier), then a live smoke test.

**Spec:** `docs/superpowers/specs/2026-08-24-combat-attributes-design.md`

**Scope:** `c:\Users\123\Projects\tg-bot\bot.js` only. troll-bot is untouched — confirmed out of scope.

---

### Task 1: Schema, formula constants, and `getStats`/`checkPvpCooldown` signatures

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:287-295` (the `pvp_stats` table — add ALTERs right after)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:946-953` (`PVP_WEAPONS`/`PVP_BODY_PARTS`/`PVP_INJURY_REFUSAL_TEXT` block — add new constants after, `PVP_INJURY_REFUSAL_TEXT` itself is removed in Task 2, not here)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1036-1039` (`getStats`)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1111-1120` (`pvpCooldowns`/`checkPvpCooldown`)

**Note on line numbers:** locate every Find block below by its surrounding text, not by trusting these line numbers — they will have drifted by the time you read this.

- [ ] **Step 1: Add the 5 `pvp_stats` columns**

Find:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS pvp_stats (
    user_id INTEGER PRIMARY KEY,
    crit_count INTEGER NOT NULL DEFAULT 0,
    injuries_dealt INTEGER NOT NULL DEFAULT 0,
    hidden_seconds INTEGER NOT NULL DEFAULT 0,
    first_tracked_at INTEGER NOT NULL
  )
`);
```

Replace with:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS pvp_stats (
    user_id INTEGER PRIMARY KEY,
    crit_count INTEGER NOT NULL DEFAULT 0,
    injuries_dealt INTEGER NOT NULL DEFAULT 0,
    hidden_seconds INTEGER NOT NULL DEFAULT 0,
    first_tracked_at INTEGER NOT NULL
  )
`);
// Four persistent combat attributes plus lifetime XP (see
// docs/superpowers/specs/2026-08-24-combat-attributes-design.md).
// Available (unspent) points are never stored separately — they're
// always computed live as floor(xp/100) - (sum of the four columns
// below), so the count can never drift out of sync with xp.
for (const [column, def] of [['accuracy', 'INTEGER NOT NULL DEFAULT 0'], ['strength', 'INTEGER NOT NULL DEFAULT 0'], ['agility', 'INTEGER NOT NULL DEFAULT 0'], ['endurance', 'INTEGER NOT NULL DEFAULT 0'], ['xp', 'INTEGER NOT NULL DEFAULT 0']]) {
  try {
    db.exec(`ALTER TABLE pvp_stats ADD COLUMN ${column} ${def}`);
  } catch {}
}
```

- [ ] **Step 2: Add the formula constants and the combat-lockout `Map`**

Find:

```js
const PVP_WEAPONS = ['палкой', 'сковородкой', 'веткой', 'ботинком', 'подушкой', 'зонтиком', 'веслом', 'шваброй', 'рыбой', 'кулаком'];
const PVP_BODY_PARTS = ['по голове', 'по спине', 'по ноге', 'по руке', 'по животу', 'по попе', 'по лбу', 'в бок'];
const PVP_INJURY_REFUSAL_TEXT = {
  arm: 'твоя рука ещё болит, не до драки!',
  leg: 'твоя нога ещё болит, не до драки!',
  head: 'твоя голова ещё болит, не до драки!',
};
```

Replace with:

```js
const PVP_WEAPONS = ['палкой', 'сковородкой', 'веткой', 'ботинком', 'подушкой', 'зонтиком', 'веслом', 'шваброй', 'рыбой', 'кулаком'];
const PVP_BODY_PARTS = ['по голове', 'по спине', 'по ноге', 'по руке', 'по животу', 'по попе', 'по лбу', 'в бок'];
const PVP_INJURY_REFUSAL_TEXT = {
  arm: 'твоя рука ещё болит, не до драки!',
  leg: 'твоя нога ещё болит, не до драки!',
  head: 'твоя голова ещё болит, не до драки!',
};

// Combat attribute formulas (see docs/superpowers/specs/
// 2026-08-24-combat-attributes-design.md) — named constants so these
// are trivial to retune later; they're honest guesses, not
// balance-tested numbers.
const ACCURACY_PER_POINT = 1;             // pp off the hit threshold, per point
const HEAD_INJURY_ACCURACY_PENALTY = 10;  // pp added back for the attacker's own head injury
const STRENGTH_DAMAGE_PER_POINT = 0.02;   // +2% damage per point, multiplicative
const ARM_INJURY_DAMAGE_MULT = 0.9;       // -10% damage, multiplicative, for the attacker's own arm injury
const BASE_DODGE_CHANCE = 50;             // %
const AGILITY_DODGE_PER_POINT = 0.5;      // pp per point of the DEFENDER's agility
const MAX_DODGE_CHANCE = 90;              // hard cap so nothing is ever unhittable
const LEG_INJURY_DODGE_PENALTY = 10;      // pp off dodge, for the DEFENDER's own leg injury
const AGILITY_COOLDOWN_PER_POINT = 0.005; // -0.5% off the PvP cooldown per point of the ATTACKER's agility
const ENDURANCE_REGEN_SPEEDUP_PER_POINT = 0.01; // -1% off the energy regen interval per point
const MIN_ENERGY_REGEN_INTERVAL_SECONDS = 300;  // floor at 5 min (base is 20 min)
const XP_PER_HIT = 1;
const XP_PER_CRIT = 5;
const XP_PER_NAT100 = 15;

// 20-minute чулан lockout for anyone who actually lands a hit (see
// /hide below) — in-memory, same idiom as hideCooldowns/pvpCooldowns,
// doesn't need to survive a restart.
const combatLockouts = new Map();
const NO_HIDE_AFTER_ATTACK_MS = 20 * 60 * 1000;
```

- [ ] **Step 3: `getStats` returns the 5 new columns too**

Find:

```js
function getStats(userId) {
  ensureStatsRow(userId);
  return db.prepare('SELECT crit_count, injuries_dealt, hidden_seconds, first_tracked_at FROM pvp_stats WHERE user_id = ?').get(userId);
}
```

Replace with:

```js
function getStats(userId) {
  ensureStatsRow(userId);
  return db.prepare('SELECT crit_count, injuries_dealt, hidden_seconds, first_tracked_at, accuracy, strength, agility, endurance, xp FROM pvp_stats WHERE user_id = ?').get(userId);
}
```

- [ ] **Step 4: `checkPvpCooldown` takes an explicit duration instead of the flat constant**

Find:

```js
const pvpCooldowns = new Map();
const PVP_COOLDOWN_MS = 60 * 1000;
function checkPvpCooldown(userId, weaponKey) {
  const cooldownKey = `${userId}:${weaponKey || 'bare'}`;
  const last = pvpCooldowns.get(cooldownKey);
  const elapsed = last ? Date.now() - last : Infinity;
  if (elapsed < PVP_COOLDOWN_MS) return Math.ceil((PVP_COOLDOWN_MS - elapsed) / 1000);
  pvpCooldowns.set(cooldownKey, Date.now());
  return 0;
}
```

Replace with:

```js
const pvpCooldowns = new Map();
const PVP_COOLDOWN_MS = 60 * 1000;
const MIN_PVP_COOLDOWN_MS = PVP_COOLDOWN_MS * 0.2; // floor at 20% of base (12s) regardless of agility
// cooldownMs is now supplied by the caller (see performKick) since it
// depends on the attacker's own agility — this function stays a pure
// rate limiter, no attribute lookups here.
function checkPvpCooldown(userId, weaponKey, cooldownMs) {
  const cooldownKey = `${userId}:${weaponKey || 'bare'}`;
  const last = pvpCooldowns.get(cooldownKey);
  const elapsed = last ? Date.now() - last : Infinity;
  if (elapsed < cooldownMs) return Math.ceil((cooldownMs - elapsed) / 1000);
  pvpCooldowns.set(cooldownKey, Date.now());
  return 0;
}
```

- [ ] **Step 5: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Verify the available-points formula never drifts**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE pvp_stats (user_id INTEGER PRIMARY KEY, crit_count INTEGER NOT NULL DEFAULT 0, injuries_dealt INTEGER NOT NULL DEFAULT 0, hidden_seconds INTEGER NOT NULL DEFAULT 0, first_tracked_at INTEGER NOT NULL, accuracy INTEGER NOT NULL DEFAULT 0, strength INTEGER NOT NULL DEFAULT 0, agility INTEGER NOT NULL DEFAULT 0, endurance INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0)\`);
db.prepare('INSERT INTO pvp_stats (user_id, first_tracked_at) VALUES (1, 0)').run();

function available() {
  const s = db.prepare('SELECT accuracy, strength, agility, endurance, xp FROM pvp_stats WHERE user_id = 1').get();
  return Math.floor(s.xp / 100) - (s.accuracy + s.strength + s.agility + s.endurance);
}

db.prepare('UPDATE pvp_stats SET xp = xp + 250 WHERE user_id = 1').run();
console.log('250 xp -> available:', available(), 'expected 2');
db.prepare('UPDATE pvp_stats SET accuracy = accuracy + 1 WHERE user_id = 1').run();
console.log('spent 1 on accuracy -> available:', available(), 'expected 1');
db.prepare('UPDATE pvp_stats SET strength = strength + 1 WHERE user_id = 1').run();
console.log('spent 1 on strength -> available:', available(), 'expected 0');
db.prepare('UPDATE pvp_stats SET xp = xp + 60 WHERE user_id = 1').run();
console.log('+60 more xp (310 total) -> available:', available(), 'expected 0');
db.prepare('UPDATE pvp_stats SET xp = xp + 40 WHERE user_id = 1').run();
console.log('+40 more xp (350 total) -> available:', available(), 'expected 1');
"
```

Expected output (in order):
```
250 xp -> available: 2 expected 2
spent 1 on accuracy -> available: 1 expected 1
spent 1 on strength -> available: 0 expected 0
+60 more xp (310 total) -> available: 0 expected 0
+40 more xp (350 total) -> available: 1 expected 1
```

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat: add combat attribute columns, formula constants, and combat lockout map"
git push
```

---

### Task 2: `performKick` — two-stage hit resolution, injury rework, damage modifiers, XP

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (the `performKick` function — restructures its hit-resolution section, leaves the rest intact)

**Note on line numbers:** Task 1 added lines earlier in the file. Locate this Find block by its surrounding text — it is large (spans from the injury-refusal check through the crit block) so match it by exact content, not any stated line number.

This is the single largest, most consequential edit in this plan. Read the whole replacement block below carefully before applying it — trace what happens to `roll`, `success`, `dodged`, `hole`, and `isCrit` at each step, since several later parts of the function (the crit-suppression condition, the carrot cat/fox block, the knockout offer) still depend on values computed here.

- [ ] **Step 1: Replace the injury-refusal block through weapon/cooldown resolution**

Find:

```js
  const injury = getUserInjury(attacker.id);
  if (injury) {
    bot.sendMessage(chatId, `${actorLabel}, ${PVP_INJURY_REFUSAL_TEXT[injury]}`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  const attackerHealth = getUserHealth(attacker.id);
  if (isKnockedOut(attacker.id)) {
    bot.sendMessage(chatId, `${actorLabel}, твоя в отключке, какая драка!`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (attackerHealth.energy === 0) {
    bot.sendMessage(chatId, `${actorLabel}, нет энергии на удар — отдохни (⚡ 1 за 20 мин).`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  // Weapon is resolved before the cooldown check since the cooldown is
  // keyed by weapon (see checkPvpCooldown) — which bucket applies depends
  // on what this swing actually turns out to be (including the
  // empty-slot-falls-back-to-bare-handed case).
  const weapon = pickWeaponForAttacker('human', attacker.id, slot, PVP_WEAPONS);
  const cooldownRemaining = checkPvpCooldown(attacker.id, weapon.key);
  if (cooldownRemaining > 0) {
    bot.sendMessage(
      chatId,
      `${actorLabel}, нельзя бить так часто ${weapon.key ? WEAPON_DEFS[weapon.key].instrumental : 'голыми руками'} — подожди ещё ${cooldownRemaining} сек.`,
      threadOpts(msgLike)
    ).catch(() => {});
    return;
  }

  if (isHidden(attacker.id)) {
    endHideSession(attacker.id, Math.floor(Date.now() / 1000));
    await bot.sendMessage(chatId, `🚪 ${actorLabel} выскакивает из чулана, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  consumeEnergy(attacker.id);

  const bodyPart = pick(PVP_BODY_PARTS);
  const roll = Math.floor(Math.random() * 101);
  const success = roll >= getHitThreshold(target.id);
  const outcome = success ? '✅ удачно' : '❌ неудачно';
  await bot.sendMessage(
    chatId,
    `${actorLabel} — ударить ${targetLabel} ${weapon.text} ${bodyPart} ${outcome}: ${roll}/100`,
    threadOpts(msgLike)
  ).catch(() => {});
  if (!success) {
    // Natural 0 with a real weapon in hand — fumble drops it right there
    // in this chat. owner_type = 'dropped' takes it out of everyone's
    // getWeaponsFor (so it stops counting for /kickN or /me) until the
    // pickup listener in the main message handler hands it to whoever
    // writes next (see "--- Filter muted & animal messages ---" below).
    // Bare-handed misses (weapon.key === null) have nothing to drop.
    if (roll === 0 && weapon.key) {
      db.prepare(
        "UPDATE weapon_ownership SET owner_type = 'dropped', owner_user_id = ?, owner_username = NULL, dropped_chat_id = ? WHERE weapon_key = ?"
      ).run(attacker.id, chatId, weapon.key);
      await bot.sendMessage(
        chatId,
        `😱 ${actorLabel} так мажет, что ${WEAPON_DEFS[weapon.key].name} вылетает из рук! Кто первым напишет что-нибудь в чат — подберёт.`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
    return;
  }

  const targetHealthBefore = getUserHealth(target.id);
  let targetHealthAfter;
  let hole = null;
```

Replace with:

```js
  const attackerHealth = getUserHealth(attacker.id);
  if (isKnockedOut(attacker.id)) {
    bot.sendMessage(chatId, `${actorLabel}, твоя в отключке, какая драка!`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (attackerHealth.energy === 0) {
    bot.sendMessage(chatId, `${actorLabel}, нет энергии на удар — отдохни (⚡ 1 за 20 мин).`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  // Injuries no longer block attacking outright — see
  // docs/superpowers/specs/2026-08-24-combat-attributes-design.md.
  // attackerInjury is read once here and reused below for both the
  // accuracy penalty (head) and the damage penalty (arm); the target's
  // own injury (leg, for dodge) is read separately once the dodge roll
  // actually needs it.
  const attackerInjury = getUserInjury(attacker.id);
  const attackerStats = getStats(attacker.id);

  // Weapon is resolved before the cooldown check since the cooldown is
  // keyed by weapon (see checkPvpCooldown) — which bucket applies depends
  // on what this swing actually turns out to be (including the
  // empty-slot-falls-back-to-bare-handed case). The cooldown's own
  // duration is shortened by the attacker's agility.
  const weapon = pickWeaponForAttacker('human', attacker.id, slot, PVP_WEAPONS);
  const effectiveCooldownMs = Math.max(MIN_PVP_COOLDOWN_MS, PVP_COOLDOWN_MS * (1 - attackerStats.agility * AGILITY_COOLDOWN_PER_POINT));
  const cooldownRemaining = checkPvpCooldown(attacker.id, weapon.key, effectiveCooldownMs);
  if (cooldownRemaining > 0) {
    bot.sendMessage(
      chatId,
      `${actorLabel}, нельзя бить так часто ${weapon.key ? WEAPON_DEFS[weapon.key].instrumental : 'голыми руками'} — подожди ещё ${cooldownRemaining} сек.`,
      threadOpts(msgLike)
    ).catch(() => {});
    return;
  }

  if (isHidden(attacker.id)) {
    endHideSession(attacker.id, Math.floor(Date.now() / 1000));
    await bot.sendMessage(chatId, `🚪 ${actorLabel} выскакивает из чулана, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  consumeEnergy(attacker.id);

  const bodyPart = pick(PVP_BODY_PARTS);
  const effectiveThreshold = Math.min(95, Math.max(5,
    getHitThreshold(target.id) - attackerStats.accuracy + (attackerInjury === 'head' ? HEAD_INJURY_ACCURACY_PENALTY : 0)
  ));
  const roll = Math.floor(Math.random() * 101);
  const success = roll >= effectiveThreshold;

  // Second, independent roll: even a well-aimed hit can be dodged. A
  // natural 100 ("СОКРУШИТЕЛЬНЫЙ УДАР") always bypasses this — it's
  // meant to be unavoidable.
  let dodged = false;
  if (success && roll !== 100) {
    const targetInjury = getUserInjury(target.id);
    const targetStats = getStats(target.id);
    const dodgeChance = Math.min(MAX_DODGE_CHANCE, Math.max(0,
      BASE_DODGE_CHANCE + targetStats.agility * AGILITY_DODGE_PER_POINT - (targetInjury === 'leg' ? LEG_INJURY_DODGE_PENALTY : 0)
    ));
    dodged = Math.random() * 100 < dodgeChance;
  }

  const outcome = !success ? '❌ неудачно' : dodged ? '🌀 уворот!' : '✅ удачно';
  await bot.sendMessage(
    chatId,
    `${actorLabel} — ударить ${targetLabel} ${weapon.text} ${bodyPart} ${outcome}: ${roll}/100`,
    threadOpts(msgLike)
  ).catch(() => {});
  if (!success) {
    // Natural 0 with a real weapon in hand — fumble drops it right there
    // in this chat. owner_type = 'dropped' takes it out of everyone's
    // getWeaponsFor (so it stops counting for /kickN or /me) until the
    // pickup listener in the main message handler hands it to whoever
    // writes next (see "--- Filter muted & animal messages ---" below).
    // Bare-handed misses (weapon.key === null) have nothing to drop.
    if (roll === 0 && weapon.key) {
      db.prepare(
        "UPDATE weapon_ownership SET owner_type = 'dropped', owner_user_id = ?, owner_username = NULL, dropped_chat_id = ? WHERE weapon_key = ?"
      ).run(attacker.id, chatId, weapon.key);
      await bot.sendMessage(
        chatId,
        `😱 ${actorLabel} так мажет, что ${WEAPON_DEFS[weapon.key].name} вылетает из рук! Кто первым напишет что-нибудь в чат — подберёт.`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
    return;
  }
  if (dodged) {
    // No damage, no weapon side effects, no crit roll, no XP, no чулан
    // lockout — exactly as if the attack had missed outright.
    return;
  }

  // A genuinely landed hit: stamp the чулан lockout immediately (this
  // must happen regardless of what the damage-calc branch below turns
  // out to be — even a carrot "dick" heal counts as "вступил в драку").
  combatLockouts.set(attacker.id, Date.now());

  const strengthFactor = 1 + attackerStats.strength * STRENGTH_DAMAGE_PER_POINT;
  const armInjuryFactor = attackerInjury === 'arm' ? ARM_INJURY_DAMAGE_MULT : 1;

  const targetHealthBefore = getUserHealth(target.id);
  let targetHealthAfter;
  let hole = null;
```

- [ ] **Step 2: Apply the strength/arm-injury multiplier to the *graduated* damage sites only**

Find:

```js
    if (hole === 'ear') {
      const dmg = Math.round(rawDmg * 0.8);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в ухо! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'nose') {
      const dmg = Math.round(rawDmg * 0.9);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в нос! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'mouth') {
      const dmg = Math.round(rawDmg * 0.5);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в рот! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'dick') {
```

Replace with:

```js
    if (hole === 'ear') {
      const dmg = Math.round(rawDmg * 0.8 * strengthFactor * armInjuryFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в ухо! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'nose') {
      const dmg = Math.round(rawDmg * 0.9 * strengthFactor * armInjuryFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в нос! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'mouth') {
      const dmg = Math.round(rawDmg * 0.5 * strengthFactor * armInjuryFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в рот! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'dick') {
```

(The `dick` and `ass` branches, and the `roll === 100` branch above the carrot `if`, are intentionally left untouched — see the design spec's explanation of why strength doesn't apply to them.)

- [ ] **Step 3: Apply the same multiplier to the generic (non-carrot) damage branch**

Find:

```js
  } else {
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const dmg = Math.round(rawDmg * weapon.multiplier);
    targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(
      chatId,
      `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
      threadOpts(msgLike)
    ).catch(() => {});
  }
```

Replace with:

```js
  } else {
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const dmg = Math.round(rawDmg * weapon.multiplier * strengthFactor * armInjuryFactor);
    targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(
      chatId,
      `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
      threadOpts(msgLike)
    ).catch(() => {});
  }
```

- [ ] **Step 4: Award XP alongside the existing crit determination**

Find:

```js
  // isCrit is tracked for stats independent of whether the injury/steal
  // side effects below actually fire — a nat-100 or carrot's "ass" is
  // still a critical hit in spirit, just with its own devastating effect
  // already covering the "this was a big deal" side effects, so the
  // usual injury+steal block is suppressed for those two specifically.
  const isCrit = roll >= getCritThreshold(attacker.id);
  if (isCrit) {
    recordCrit(attacker.id);
  }
  if (roll !== 100 && isCrit && !(weapon.key === 'carrot' && hole === 'ass')) {
```

Replace with:

```js
  // isCrit is tracked for stats independent of whether the injury/steal
  // side effects below actually fire — a nat-100 or carrot's "ass" is
  // still a critical hit in spirit, just with its own devastating effect
  // already covering the "this was a big deal" side effects, so the
  // usual injury+steal block is suppressed for those two specifically.
  const isCrit = roll >= getCritThreshold(attacker.id);
  if (isCrit) {
    recordCrit(attacker.id);
  }
  // Every landed, non-dodged hit earns XP, tiered by outcome — this is
  // reached unconditionally (unlike the injury+steal block below, which
  // stays gated on roll !== 100 and the carrot-ass suppression).
  const xpGain = roll === 100 ? XP_PER_NAT100 : isCrit ? XP_PER_CRIT : XP_PER_HIT;
  ensureStatsRow(attacker.id);
  db.prepare('UPDATE pvp_stats SET xp = xp + ? WHERE user_id = ?').run(xpGain, attacker.id);
  if (roll !== 100 && isCrit && !(weapon.key === 'carrot' && hole === 'ass')) {
```

- [ ] **Step 5: Remove the now-fully-unused `PVP_INJURY_REFUSAL_TEXT` constant**

Find:

```js
const PVP_INJURY_REFUSAL_TEXT = {
  arm: 'твоя рука ещё болит, не до драки!',
  leg: 'твоя нога ещё болит, не до драки!',
  head: 'твоя голова ещё болит, не до драки!',
};
```

Replace with: (delete entirely — remove these 5 lines)

Verify no other reference remains: `grep -n PVP_INJURY_REFUSAL_TEXT bot.js` must return nothing.

- [ ] **Step 6: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Verify the accuracy-threshold clamp, dodge-chance clamp, and damage-multiplier math in isolation**

```bash
node -e "
const ACCURACY_PER_POINT = 1;
const HEAD_INJURY_ACCURACY_PENALTY = 10;
function effectiveThreshold(baseThreshold, accuracy, headInjury) {
  return Math.min(95, Math.max(5, baseThreshold - accuracy + (headInjury ? HEAD_INJURY_ACCURACY_PENALTY : 0)));
}
console.log('base 50, 0 accuracy, no injury:', effectiveThreshold(50, 0, false), 'expected 50');
console.log('base 50, 30 accuracy, no injury:', effectiveThreshold(50, 30, false), 'expected 20');
console.log('base 50, 200 accuracy (clamp floor):', effectiveThreshold(50, 200, false), 'expected 5');
console.log('base 50, 0 accuracy, head injury:', effectiveThreshold(50, 0, true), 'expected 60');
console.log('base 90 (dodge buff), 200 accuracy, head injury (clamp floor still wins):', effectiveThreshold(90, 200, true), 'expected 5');

const BASE_DODGE_CHANCE = 50, AGILITY_DODGE_PER_POINT = 0.5, MAX_DODGE_CHANCE = 90, LEG_INJURY_DODGE_PENALTY = 10;
function dodgeChance(agility, legInjury) {
  return Math.min(MAX_DODGE_CHANCE, Math.max(0, BASE_DODGE_CHANCE + agility * AGILITY_DODGE_PER_POINT - (legInjury ? LEG_INJURY_DODGE_PENALTY : 0)));
}
console.log('0 agility, no injury:', dodgeChance(0, false), 'expected 50');
console.log('1000 agility (clamp ceiling):', dodgeChance(1000, false), 'expected 90');
console.log('0 agility, leg injury:', dodgeChance(0, true), 'expected 40');
console.log('20 agility, leg injury:', dodgeChance(20, true), 'expected 40');

const STRENGTH_DAMAGE_PER_POINT = 0.02, ARM_INJURY_DAMAGE_MULT = 0.9;
function dmg(rawDmg, weaponMult, strength, armInjury) {
  return Math.round(rawDmg * weaponMult * (1 + strength * STRENGTH_DAMAGE_PER_POINT) * (armInjury ? ARM_INJURY_DAMAGE_MULT : 1));
}
console.log('10 raw, 1.5x weapon, 0 strength, no injury:', dmg(10, 1.5, 0, false), 'expected 15');
console.log('10 raw, 1.5x weapon, 50 strength, no injury:', dmg(10, 1.5, 50, false), 'expected 30');
console.log('10 raw, 1.5x weapon, 0 strength, arm injury:', dmg(10, 1.5, 0, true), 'expected 14 (13.5 rounds to 14)');
"
```

Expected output (in order):
```
base 50, 0 accuracy, no injury: 50 expected 50
base 50, 30 accuracy, no injury: 20 expected 20
base 50, 200 accuracy (clamp floor): 5 expected 5
base 50, 0 accuracy, head injury: 60 expected 60
base 90 (dodge buff), 200 accuracy, head injury (clamp floor still wins): 5 expected 5
0 agility, no injury: 50 expected 50
1000 agility (clamp ceiling): 90 expected 90
0 agility, leg injury: 40 expected 40
20 agility, leg injury: 40 expected 40
10 raw, 1.5x weapon, 0 strength, no injury: 15 expected 15
10 raw, 1.5x weapon, 50 strength, no injury: 30 expected 30
10 raw, 1.5x weapon, 0 strength, arm injury: 14 expected 14 (13.5 rounds to 14)
```

- [ ] **Step 8: Commit**

```bash
git add bot.js
git commit -m "feat: rework /kick's injury handling into targeted attribute penalties, add dodge roll and XP"
git push
```

---

### Task 3: `/hide` — 20-minute post-attack чулан lockout

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (the `/hide` handler)

**Note on line numbers:** Tasks 1-2 shifted lines earlier in the file. Locate by surrounding text.

- [ ] **Step 1: Add the lockout check right after the hours-validation check**

Find:

```js
bot.onText(/\/hide(?:\s+(\d+))?\b/, (msg, match) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const hours = match[1] ? parseInt(match[1], 10) : 1;
  if (hours < 1) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, укажи хотя бы 1 час: /hide 1`, threadOpts(msg)).catch(() => {});
    return;
  }

  const last = hideCooldowns.get(msg.from.id);
```

Replace with:

```js
bot.onText(/\/hide(?:\s+(\d+))?\b/, (msg, match) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const hours = match[1] ? parseInt(match[1], 10) : 1;
  if (hours < 1) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, укажи хотя бы 1 час: /hide 1`, threadOpts(msg)).catch(() => {});
    return;
  }

  const lastAttack = combatLockouts.get(msg.from.id);
  if (lastAttack && Date.now() - lastAttack < NO_HIDE_AFTER_ATTACK_MS) {
    const remaining = Math.ceil((NO_HIDE_AFTER_ATTACK_MS - (Date.now() - lastAttack)) / 60000);
    bot.sendMessage(msg.chat.id, `${actorLabel}, только что дрался — нельзя прятаться ещё ${remaining} мин.`, threadOpts(msg)).catch(() => {});
    return;
  }

  const last = hideCooldowns.get(msg.from.id);
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: block /hide for 20 minutes after landing a hit"
git push
```

---

### Task 4: `healthRegenTick` — per-user energy regen interval from endurance

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (the `healthRegenTick` function's energy-regen loop)

**Note on line numbers:** Tasks 1-3 shifted lines earlier in the file. Locate by surrounding text.

- [ ] **Step 1: Join `pvp_stats` for the per-user regen interval**

Find:

```js
    const energyRows = db.prepare('SELECT user_id, energy, max_energy, last_energy_regen_at FROM user_health WHERE energy < max_energy').all();
    for (const row of energyRows) {
      const elapsedSeconds = row.last_energy_regen_at ? now - row.last_energy_regen_at : ENERGY_REGEN_INTERVAL_SECONDS;
      const gain = Math.floor(elapsedSeconds / ENERGY_REGEN_INTERVAL_SECONDS);
      if (gain > 0) {
        db.prepare('UPDATE user_health SET energy = MIN(max_energy, energy + ?), last_energy_regen_at = ? WHERE user_id = ?').run(gain, now, row.user_id);
      }
    }
```

Replace with:

```js
    // LEFT JOIN since not every user_health row necessarily has a
    // pvp_stats row yet (ensureStatsRow only fires lazily, on combat
    // actions) — COALESCE defaults a missing row to 0 endurance, same
    // as everywhere else that reads an attribute.
    const energyRows = db.prepare(
      'SELECT uh.user_id, uh.energy, uh.max_energy, uh.last_energy_regen_at, COALESCE(ps.endurance, 0) AS endurance ' +
      'FROM user_health uh LEFT JOIN pvp_stats ps ON ps.user_id = uh.user_id ' +
      'WHERE uh.energy < uh.max_energy'
    ).all();
    for (const row of energyRows) {
      const intervalSeconds = Math.max(MIN_ENERGY_REGEN_INTERVAL_SECONDS, ENERGY_REGEN_INTERVAL_SECONDS * (1 - row.endurance * ENDURANCE_REGEN_SPEEDUP_PER_POINT));
      const elapsedSeconds = row.last_energy_regen_at ? now - row.last_energy_regen_at : intervalSeconds;
      const gain = Math.floor(elapsedSeconds / intervalSeconds);
      if (gain > 0) {
        db.prepare('UPDATE user_health SET energy = MIN(max_energy, energy + ?), last_energy_regen_at = ? WHERE user_id = ?').run(gain, now, row.user_id);
      }
    }
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the per-user interval formula in isolation**

```bash
node -e "
const ENERGY_REGEN_INTERVAL_SECONDS = 20 * 60;
const ENDURANCE_REGEN_SPEEDUP_PER_POINT = 0.01;
const MIN_ENERGY_REGEN_INTERVAL_SECONDS = 300;
function interval(endurance) {
  return Math.max(MIN_ENERGY_REGEN_INTERVAL_SECONDS, ENERGY_REGEN_INTERVAL_SECONDS * (1 - endurance * ENDURANCE_REGEN_SPEEDUP_PER_POINT));
}
console.log('0 endurance:', interval(0), 'expected 1200');
console.log('50 endurance:', interval(50), 'expected 600');
console.log('1000 endurance (clamp floor):', interval(1000), 'expected 300');
"
```

Expected output (in order):
```
0 endurance: 1200 expected 1200
50 endurance: 600 expected 600
1000 endurance (clamp floor): 300 expected 300
```

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: speed up energy regen per point of endurance"
git push
```

---

### Task 5: `/levelup` command

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (new command, placed right after `/find`'s handler)

**Note on line numbers:** locate the end of `/find`'s handler (`bot.onText(/\/find\b/, ...)`) by its closing `});` — insert this new command directly after it.

- [ ] **Step 1: Add the `/levelup` handler**

Find:

```js
  const lines = ['Бойцы:', ...hiddenLines, ...visibleLines];
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});
```

Replace with:

```js
  const lines = ['Бойцы:', ...hiddenLines, ...visibleLines];
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});

// /levelup — spends one banked attribute point (see getStats/pvp_stats
// and docs/superpowers/specs/2026-08-24-combat-attributes-design.md
// for the available-points formula). statColumn is only ever one of
// these 4 hardcoded strings from LEVELUP_STAT_NAMES — never raw user
// input — so interpolating it into the UPDATE below isn't a SQL
// injection risk despite not being a bound parameter.
const LEVELUP_STAT_NAMES = {
  'точность': 'accuracy', 'точн': 'accuracy',
  'сила': 'strength', 'сил': 'strength',
  'ловкость': 'agility', 'ловк': 'agility',
  'выносливость': 'endurance', 'вын': 'endurance',
};
const LEVELUP_STAT_LABELS = { accuracy: 'точность', strength: 'сила', agility: 'ловкость', endurance: 'выносливость' };
bot.onText(/\/levelup(?:\s+(\S+))?/i, (msg, match) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const arg = match[1] ? match[1].toLowerCase() : null;
  const statColumn = arg ? LEVELUP_STAT_NAMES[arg] : null;
  if (!statColumn) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, укажи характеристику: /levelup точность|сила|ловкость|выносливость`, threadOpts(msg)).catch(() => {});
    return;
  }

  const stats = getStats(msg.from.id);
  const available = Math.floor(stats.xp / 100) - (stats.accuracy + stats.strength + stats.agility + stats.endurance);
  if (available <= 0) {
    const needed = 100 - (stats.xp % 100);
    bot.sendMessage(msg.chat.id, `${actorLabel}, нет свободных очков — ещё ${needed} XP до следующего.`, threadOpts(msg)).catch(() => {});
    return;
  }

  db.prepare(`UPDATE pvp_stats SET ${statColumn} = ${statColumn} + 1 WHERE user_id = ?`).run(msg.from.id);
  if (statColumn === 'endurance') {
    db.prepare('UPDATE user_health SET max_energy = max_energy + 1 WHERE user_id = ?').run(msg.from.id);
  }
  const newValue = stats[statColumn] + 1;
  const remaining = available - 1;
  bot.sendMessage(
    msg.chat.id,
    `${actorLabel}, ${LEVELUP_STAT_LABELS[statColumn]} теперь ${newValue}. Осталось очков: ${remaining}.`,
    threadOpts(msg)
  ).catch(() => {});
});
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the stat-name matching and point-spend flow in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE pvp_stats (user_id INTEGER PRIMARY KEY, accuracy INTEGER NOT NULL DEFAULT 0, strength INTEGER NOT NULL DEFAULT 0, agility INTEGER NOT NULL DEFAULT 0, endurance INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0)\`);
db.exec(\`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, max_energy INTEGER NOT NULL DEFAULT 10)\`);
db.prepare('INSERT INTO pvp_stats (user_id, xp) VALUES (1, 150)').run();
db.prepare('INSERT INTO user_health (user_id) VALUES (1)').run();

const LEVELUP_STAT_NAMES = { 'точность': 'accuracy', 'точн': 'accuracy', 'выносливость': 'endurance', 'вын': 'endurance' };
console.log('short form resolves:', LEVELUP_STAT_NAMES['вын'], 'expected endurance');
console.log('unknown word:', LEVELUP_STAT_NAMES['ерунда'], 'expected undefined');

function spend(statColumn) {
  const stats = db.prepare('SELECT accuracy, strength, agility, endurance, xp FROM pvp_stats WHERE user_id = 1').get();
  const available = Math.floor(stats.xp / 100) - (stats.accuracy + stats.strength + stats.agility + stats.endurance);
  if (available <= 0) return 'no points';
  db.prepare(\`UPDATE pvp_stats SET \${statColumn} = \${statColumn} + 1 WHERE user_id = 1\`).run();
  if (statColumn === 'endurance') db.prepare('UPDATE user_health SET max_energy = max_energy + 1 WHERE user_id = 1').run();
  return 'spent';
}
console.log('spend 1 (150xp, 1 available):', spend('endurance'));
console.log('max_energy after endurance spend:', db.prepare('SELECT max_energy FROM user_health WHERE user_id=1').get().max_energy, 'expected 11');
console.log('spend 2 (now 0 available):', spend('accuracy'), 'expected no points');
"
```

Expected output (in order):
```
short form resolves: endurance expected endurance
unknown word: undefined expected undefined
spend 1 (150xp, 1 available): spent
max_energy after endurance spend: 11 expected 11
spend 2 (now 0 available): no points expected no points
```

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add /levelup command to spend banked attribute points"
git push
```

---

### Task 6: `/me` — display attributes, XP, and available points

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (the `/me` handler)

**Note on line numbers:** locate by surrounding text.

- [ ] **Step 1: Add the attributes/XP lines**

Find:

```js
  lines.push(`⚔️ Крит. ударов нанесено: ${stats.crit_count}`);
  lines.push(`🤕 Травм нанесено: ${stats.injuries_dealt}`);
  lines.push(`🐰 В чулане провёл: ${formatDuration(liveHiddenSeconds)}`);
  lines.push(`🏃 Вне чулана: ${formatDuration(visibleSeconds)}`);

  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});
```

Replace with:

```js
  lines.push(`⚔️ Крит. ударов нанесено: ${stats.crit_count}`);
  lines.push(`🤕 Травм нанесено: ${stats.injuries_dealt}`);
  lines.push(`🐰 В чулане провёл: ${formatDuration(liveHiddenSeconds)}`);
  lines.push(`🏃 Вне чулана: ${formatDuration(visibleSeconds)}`);

  const available = Math.floor(stats.xp / 100) - (stats.accuracy + stats.strength + stats.agility + stats.endurance);
  lines.push(`📊 Точность: ${stats.accuracy} | Сила: ${stats.strength} | Ловкость: ${stats.agility} | Выносливость: ${stats.endurance}`);
  lines.push(`✨ Опыт: ${stats.xp} (ещё ${100 - (stats.xp % 100)} до следующего очка)${available > 0 ? ` — доступно очков: ${available}` : ''}`);

  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: show combat attributes and XP in /me"
git push
```

---

### Task 7: `/help` text

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (the PvP section of `/help`)

**Note on line numbers:** locate by surrounding text.

- [ ] **Step 1: Update `/kick`'s line and add `/levelup`**

Find:

```js
    '/kick @юзернейм (или ответом) — ударить подручными средствами; /kick1, /kick2, /kick3 — конкретным оружием по номеру слота (см. /me), если в слоте пусто — тоже подручными (без ответного удара; урон 1-20, критический удар — травма на 2-24 часа, 0 здоровья — мут на 30 мин + если у жертвы было оружие, добивший получает кнопки забрать/оставить, при нескольких — выбор какое; тратит 1 энергию из 10, восстановление — 1 за 20 мин; пауза 1 мин действует отдельно на каждое оружие/на голые руки; ровно 100/100 — сразу сносит всю жизнь цели; ровно 0/100 с оружием в руке — роняет его, первый написавший в чат кроме тебя подбирает)',
    '/hide [часы] — спрятаться в чулане от /kick на N часов (по умолчанию 1); чулан вмещает только 5 человек — если он полон, новый прячущийся случайно выкидывает оттуда кого-то одного; тратит N энергии сразу, при недостатке энергии — отказ; своя атака снимает прятки; сама команда — раз в 20 минут',
    '/find — список всех бойцов: 🐰 сначала те, кто в чулане (с оставшимся временем), затем ⚔️ остальные',
```

Replace with:

```js
    '/kick @юзернейм (или ответом) — ударить подручными средствами; /kick1, /kick2, /kick3 — конкретным оружием по номеру слота (см. /me), если в слоте пусто — тоже подручными (без ответного удара; урон 1-20 × сила и множитель оружия, попадание зависит от точности, после попадания жертва может увернуться (базово 50%, зависит от её ловкости); критический удар — травма на 2-24 часа (голова -10% точности, рука -10% урона, нога -10% уворота у пострадавшего — не блокирует атаку), 0 здоровья — мут на 30 мин + если у жертвы было оружие, добивший получает кнопки забрать/оставить, при нескольких — выбор какое; тратит 1 энергию из 10, восстановление зависит от выносливости; пауза между ударами зависит от ловкости, действует отдельно на каждое оружие/на голые руки; ровно 100/100 — не увернуться, сразу сносит всю жизнь цели; ровно 0/100 с оружием в руке — роняет его, первый написавший в чат кроме тебя подбирает; удачный удар даёт опыт — см. /levelup)',
    '/hide [часы] — спрятаться в чулане от /kick на N часов (по умолчанию 1); чулан вмещает только 5 человек — если он полон, новый прячущийся случайно выкидывает оттуда кого-то одного; тратит N энергии сразу, при недостатке энергии — отказ; своя атака снимает прятки и на 20 минут блокирует повторный /hide; сама команда — раз в 20 минут',
    '/find — список всех бойцов: 🐰 сначала те, кто в чулане (с оставшимся временем), затем ⚔️ остальные',
    '/levelup точность|сила|ловкость|выносливость — тратит 1 очко характеристики (1 очко = каждые 100 опыта; опыт: +1 за удачный удар, +5 за крит, +15 за 100/100)',
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "docs: update /help for the combat attributes rework and /levelup"
git push
```

---

### Task 8: Manual end-to-end verification

**Files:** none (verification only, against the running bot — deploy is the user's own flow)

- [ ] **Step 1: Confirm an injury no longer blocks attacking**

Get crit-injured (or manually set an `injuries` row), confirm `/kick` still works and produces a visibly different result depending on the injury type (harder to hit with a head injury, less damage with an arm injury, easier to be hit/harder to dodge as the *target* with a leg injury).

- [ ] **Step 2: Confirm the dodge roll**

Land several hits against the same target and confirm `🌀 уворот!` appears sometimes (~50% of hits, absent any agility/injury modifiers) with no damage/side-effects/XP on those swings.

- [ ] **Step 3: Confirm nat-100 bypasses dodge**

Land enough hits to observe a 100/100 roll; confirm it never shows `🌀 уворот!` and always floors health to 0.

- [ ] **Step 4: Confirm XP accrual and `/levelup`**

Check `/me` before and after a few hits (normal, crit, nat-100 if you get lucky) and confirm XP increases by 1/5/15 respectively. Once at 100+, run `/levelup сила` (and the short form `/levelup сил`) and confirm the stat increases and the message reports the right remaining points.

- [ ] **Step 5: Confirm endurance's two effects**

`/levelup выносливость` a few times, confirm `/me`'s max energy rises immediately, and confirm energy regenerates faster than the default 20-minute cadence afterward (or verify via a direct `UPDATE pvp_stats SET endurance = 50 WHERE user_id = ...` on prod for faster testing).

- [ ] **Step 6: Confirm the 20-minute post-hit `/hide` lockout**

Land a hit, then immediately try `/hide` — confirm it's refused with a remaining-minutes message, and that missing or getting dodged does *not* trigger this lockout.

- [ ] **Step 7: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as the earlier tasks.
