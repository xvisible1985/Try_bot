# Combat attributes, injury rework, and dodge — design

## Purpose

Replace `/kick`'s two blunt mechanics — an injury that fully blocks the
injured person from attacking, and a single hit/miss roll with no
persistent character progression — with:

1. Four persistent per-fighter attributes (точность/сила/ловкость/
   выносливость) that a player levels up over time by fighting.
2. Injuries that apply a targeted -10% penalty to whichever attribute
   they logically affect, instead of refusing to let the injured
   person swing at all.
3. A second, independent dodge roll after every landed hit.
4. An XP/leveling system: XP from landed hits banks up, and every 100
   XP unlocks one attribute point to spend via a new `/levelup`
   command.
5. A 20-minute чулан lockout for anyone who actually lands a hit.

**Scope: `tg-bot`'s `/kick` only.** troll-bot's own "Драка"/"выпивка"
keep their existing full-refusal injury behavior unchanged — the
shared `injuries` table's data format doesn't change, only how
`tg-bot`'s `/kick` interprets it.

## New storage

### `pvp_stats` gains 5 columns (ALTER, same idiom as every other
column added to an existing table this session)

```sql
ALTER TABLE pvp_stats ADD COLUMN accuracy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pvp_stats ADD COLUMN strength INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pvp_stats ADD COLUMN agility INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pvp_stats ADD COLUMN endurance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pvp_stats ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
```

`xp` is a lifetime total that never decreases. Available (unspent)
attribute points are always computed live, never stored separately:

```
available = floor(xp / 100) - (accuracy + strength + agility + endurance)
```

This means there's no separate "points banked" counter to keep in
sync — the sum of the four attribute columns *is* the count of points
already spent, so it can never drift from `xp`.

## Attribute formulas

All constants below are named so they're trivial to retune later if
the numbers feel off in practice — they are honest guesses, not
balance-tested.

```js
const ACCURACY_PER_POINT = 1;            // pp off the hit threshold, per point
const HEAD_INJURY_ACCURACY_PENALTY = 10; // pp added back on for the attacker's own head injury

const STRENGTH_DAMAGE_PER_POINT = 0.02;  // +2% damage per point, multiplicative
const ARM_INJURY_DAMAGE_MULT = 0.9;      // -10% damage, multiplicative, for the attacker's own arm injury

const BASE_DODGE_CHANCE = 50;            // %
const AGILITY_DODGE_PER_POINT = 0.5;     // pp per point of the DEFENDER's agility
const MAX_DODGE_CHANCE = 90;             // hard cap so nothing is ever unhittable
const LEG_INJURY_DODGE_PENALTY = 10;     // pp off dodge, for the DEFENDER's own leg injury

const AGILITY_COOLDOWN_PER_POINT = 0.005; // -0.5% off PVP_COOLDOWN_MS per point of the ATTACKER's agility
const MIN_PVP_COOLDOWN_MS = PVP_COOLDOWN_MS * 0.2; // floor at 20% of base (12s)

const ENDURANCE_REGEN_SPEEDUP_PER_POINT = 0.01; // -1% off the energy regen interval per point
const MIN_ENERGY_REGEN_INTERVAL_SECONDS = 300;  // floor at 5 min (base is 20 min)
```

- **Точность (accuracy)** — lowers the effective hit threshold the
  attacker's roll must clear. Doesn't touch `getHitThreshold` itself
  (which stays as the kuni-dodge-buff-driven base); accuracy and the
  head-injury penalty are applied on top, at the `/kick` call site:
  `effectiveThreshold = clamp(getHitThreshold(target.id) - attackerAccuracy + (headInjury ? 10 : 0), 5, 95)`.

- **Сила (strength)** — multiplies damage on top of the weapon's own
  multiplier, per the user's explicit choice. Applies only to
  *graduated* damage amounts (the generic weapon-multiplier branch,
  and carrot's ear/nose/mouth holes) — **not** to nat-100 or carrot's
  "ass" outcome, both of which deliberately deal exactly
  `targetHealthBefore.health` to floor to precisely 0; multiplying
  that would defeat the point. Not applied to carrot's "dick" heal
  either (it's not damage).
  `strengthFactor = 1 + attackerStrength * 0.02`, then
  `armInjuryFactor = armInjury ? 0.9 : 1`, both multiplied into the
  existing `Math.round(rawDmg * ...)` calls at the relevant sites.

- **Ловкость (agility)** — two independent effects:
  - *Defense:* raises the defender's own dodge chance (see below).
  - *Offense:* shortens the attacker's own cooldown for whichever
    weapon (or bare hands) they just swung —
    `effectiveCooldownMs = max(MIN_PVP_COOLDOWN_MS, PVP_COOLDOWN_MS * (1 - attackerAgility * 0.005))`,
    computed in `/kick` and passed into `checkPvpCooldown` (which
    gains a third parameter for this).

- **Выносливость (endurance)** — two independent effects:
  - *Capacity:* `+1` to `max_energy` per point. Implemented by
    directly incrementing `user_health.max_energy` whenever a point is
    spent on endurance via `/levelup` — this keeps every existing
    energy-reading call site (`getUserHealth`, `/hide`'s check,
    `consumeEnergy`, `/me`) unchanged, since `max_energy` is still just
    a plain column.
  - *Regen speed:* shortens the energy regen tick's interval for that
    user specifically —
    `intervalSeconds = max(300, 1200 * (1 - endurance * 0.01))`.
    `healthRegenTick`'s energy-regen loop needs to `LEFT JOIN
    pvp_stats` (defaulting missing rows to `endurance = 0`) to compute
    this per-user instead of using the single global
    `ENERGY_REGEN_INTERVAL_SECONDS` constant for everyone.

## Injury rework

Delete the existing full-refusal block in `performKick`:

```js
const injury = getUserInjury(attacker.id);
if (injury) {
  bot.sendMessage(chatId, `${actorLabel}, ${PVP_INJURY_REFUSAL_TEXT[injury]}`, threadOpts(msgLike)).catch(() => {});
  return;
}
```

`PVP_INJURY_REFUSAL_TEXT` becomes dead code in `tg-bot`'s `bot.js` and
should be deleted (troll-bot keeps its own separate copy,
`INJURY_REFUSAL_TEXT`, untouched — different file, different constant,
out of scope per the confirmed scope decision).

Instead, `getUserInjury(attacker.id)` and `getUserInjury(target.id)`
are each called once during hit resolution (see below) purely to
determine which of the three percentage penalties apply this swing —
no refusal, ever. An injury never *prevents* combat, it just makes
that specific aspect of it worse for as long as it lasts (unchanged:
2–24h, randomly, exactly as today).

## Two-stage hit resolution

Today: one roll, compared against `getHitThreshold(target.id)`,
success/failure decides everything. New:

1. `const attackerInjury = getUserInjury(attacker.id);` (head/arm)
2. `const effectiveThreshold = clamp(getHitThreshold(target.id) - attackerAccuracy + (attackerInjury === 'head' ? 10 : 0), 5, 95);`
3. `roll = 0..100`, `success = roll >= effectiveThreshold` — same as
   today, just against the adjusted threshold.
4. **If not successful:** existing miss-handling unchanged (including
   the nat-0 weapon-fumble-drop check) — nothing new here, dodge never
   enters into a miss.
5. **If successful and `roll !== 100`:** a second, independent roll
   decides whether the target dodges:
   - `const targetInjury = getUserInjury(target.id);` (leg)
   - `const targetAgility = getStats(target.id).agility;`
   - `const dodgeChance = clamp(50 + targetAgility * 0.5 - (targetInjury === 'leg' ? 10 : 0), 0, 90);`
   - `const dodged = Math.random() * 100 < dodgeChance;`
6. **`roll === 100` always bypasses the dodge roll** — a nat-100
   "СОКРУШИТЕЛЬНЫЙ УДАР" cannot be dodged, matching its existing
   "instant full wipe" framing.
7. The single roll-announcement message picks one of three outcome
   strings instead of two:
   `!success ? '❌ неудачно' : dodged ? '🌀 уворот!' : '✅ удачно'`
8. **If dodged:** send that message and return immediately — no
   damage, no weapon side effects, no crit roll, no XP, no чулан
   lockout. Exactly as if the attack had missed, narratively distinct
   only in the displayed outcome text.
9. **If not dodged (or nat-100):** proceed into the existing
   damage-calculation branches (nat-100 / carrot holes / generic),
   with the strength/arm-injury multiplier applied at the *graduated*
   damage sites as described above.

## XP and `/levelup`

Awarded once per landed (non-dodged, non-miss) hit, tiered by outcome,
using the existing `isCrit` flag and `roll === 100` check that already
exist in `performKick`:

```js
const xpGain = roll === 100 ? 15 : isCrit ? 5 : 1;
db.prepare('UPDATE pvp_stats SET xp = xp + ? WHERE user_id = ?').run(xpGain, attacker.id);
```

(Call `ensureStatsRow(attacker.id)` first, same as every other
`pvp_stats` writer.)

New command:

```
/levelup точность|сила|ловкость|выносливость
```

Case-insensitive; accepts short forms (`точн`, `сил`, `ловк`, `вын`)
via prefix match against the four full Russian names. Flow:

1. `getStats(msg.from.id)` (existing helper, now also returns the 5
   new columns).
2. `available = floor(xp/100) - (accuracy+strength+agility+endurance)`.
3. If `available <= 0`: "нет свободных очков — нужно ещё N XP" (N =
   `100 - (xp % 100)`).
4. If the argument doesn't match any of the four stat names: list them.
5. Otherwise: `UPDATE pvp_stats SET <stat> = <stat> + 1 WHERE user_id = ?`;
   if the stat is `endurance`, also `UPDATE user_health SET max_energy
   = max_energy + 1 WHERE user_id = ?`. Confirm with the new value and
   how many points remain.

## 20-minute post-hit чулан lockout

New in-memory `Map` (same idiom as `hideCooldowns` and `pvpCooldowns` —
doesn't need to survive a restart):

```js
const combatLockouts = new Map();
const NO_HIDE_AFTER_ATTACK_MS = 20 * 60 * 1000;
```

Stamped in `performKick` at the same point XP is awarded (a landed,
non-dodged hit — a miss or a dodged swing does **not** count as
"вступил в драку"). Checked in `/hide`, before the existing cooldown/
energy checks:

```js
const lastAttack = combatLockouts.get(msg.from.id);
if (lastAttack && Date.now() - lastAttack < NO_HIDE_AFTER_ATTACK_MS) {
  const remaining = Math.ceil((NO_HIDE_AFTER_ATTACK_MS - (Date.now() - lastAttack)) / 60000);
  bot.sendMessage(msg.chat.id, `${actorLabel}, только что дрался — нельзя прятаться ещё ${remaining} мин.`, threadOpts(msg)).catch(() => {});
  return;
}
```

## `/me` additions

New block, using the same `getStats` call `/me` already makes:

```
📊 Точность: N | Сила: N | Ловкость: N | Выносливость: N
✨ Опыт: X/100 (ещё Y до следующего очка) — доступно очков: N
```

(Only show "доступно очков" line with a nonzero count if `available >
0`, to keep the common case — no points banked — from cluttering the
display with "доступно очков: 0" every time.)

## Interaction notes

- **Kuni buffs** (`/kuniFun`/`/kuniAlia`/`/kuniTama`) are untouched —
  they still modify `getCritThreshold`/`getHitThreshold` exactly as
  today, stacking as a temporary layer on top of the new permanent
  attributes (accuracy/agility apply *in addition to* whatever the
  buffs already did to the base thresholds).
- **Weapon multipliers** are untouched — strength multiplies on top of
  them, per the confirmed choice, not instead of them.
- **Carrot** keeps its existing 5-hole system; only the *graduated*
  holes (ear/nose/mouth) get the strength/arm-injury multiplier, ass/
  dick don't (see above).
- **troll-bot** is entirely out of scope for this change — its own
  `getUserInjury`/`INJURY_REFUSAL_TEXT`-based full-refusal stays
  exactly as-is for "Драка"/"выпивка".

## Testing

`node --check bot.js` for syntax, plus isolated `node -e` scripts
against scratch in-memory DBs for: the available-points formula
(including the "never drifts" property across repeated
spend-then-earn cycles), the dodge-chance clamp at its boundaries (0
and 90), the effective-hit-threshold clamp (5 and 95), the
per-user energy regen interval formula at 0/high endurance, and the
strength/arm-injury damage multiplier math. Manual live smoke test
for the full `/kick` flow, `/levelup`, and `/me`'s new display.
