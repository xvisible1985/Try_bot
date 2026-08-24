# Больничка + Защитная стойка Design

**Repo:** tg-bot only (`bot.js`). No troll-bot changes — troll-bot's own `isKnockedOut()` (reading the shared `mutes` table by reason `'драка'`) is explicitly left as-is per the user; since tg-bot will stop ever writing that mute (see below), troll-bot's copy will simply never see a hospitalized player as "knocked out" anymore. This is an accepted, intentional consequence, not a bug to fix.

This spec covers two independent features requested together:
1. **Больничка** — an automatic, health-gated recovery state entered on knockout.
2. **Защитная стойка** (`/defend`) — a voluntary, time-limited self-buff trading offense for defense.

They share no code beyond both reading/writing `user_health`/`buffs` and both participating in `performKick`'s existing "auto-break on attack" idiom (already used by `/hide`'s чулан).

---

## Part 1: Больничка

### Replaces the existing knockout mute entirely

Today, `damageHuman` calls `muteUser(userId, chatId, username, 0, 'драка', 30 * 60 * 1000)` when health hits 0, and `isKnockedOut(userId)` (bot.js:892) checks that mute row to hard-block the attacker from swinging again in `performKick`.

**This mechanism is deleted, not extended.** `damageHuman` no longer calls `muteUser` at all on knockout. `isKnockedOut()` and its one call site (`performKick`'s attacker check, bot.js:1948) are removed. Больничка is the sole replacement — no mute row is written anywhere for knockout.

### Schema

Add one column to `user_health` (same `ALTER TABLE ... try/catch` idiom used for every other column added to this table over the course of this project):

```js
for (const [column, def] of [['hospitalized_since', 'INTEGER']]) {
  try { db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`); } catch {}
}
```

`hospitalized_since`: NULL when not hospitalized; a unix timestamp (seconds) when the player entered больничка, otherwise. Its mere non-NULL-ness combined with `health < 30` is the "is hospitalized" condition — there is no separate boolean.

### `isHospitalized(userId)` helper

Lazy check-and-clear, same idiom as `isHidden`:

```js
function isHospitalized(userId) {
  const row = db.prepare('SELECT hospitalized_since, health FROM user_health WHERE user_id = ?').get(userId);
  if (!row || row.hospitalized_since === null) return false;
  if (row.health < HOSPITAL_EXIT_HEALTH) return true;
  db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(userId);
  return false;
}
```

`HOSPITAL_EXIT_HEALTH = 30` (named constant, alongside the other PvP constants near `WEAPON_DEFS`).

### Entering больничка

In `damageHuman`, where the row already checks `if (row.health === 0) { ... }`, replace the `muteUser(...)` call with setting `hospitalized_since` — but only if not already set (so re-flooring an already-hospitalized player's health to 0 again, e.g. from a stray damage event, doesn't reset their entry timestamp):

```js
if (row.health === 0) {
  db.prepare('UPDATE user_health SET hospitalized_since = COALESCE(hospitalized_since, ?) WHERE user_id = ?').run(now, userId);
}
```

(`now` is already computed earlier in `damageHuman` for `last_regen_at`.)

The existing knockout-steal-buttons offer (triggered in `performKick` off `targetHealthAfter === 0`) is completely unaffected — it doesn't touch mutes or больничка state, and continues exactly as today.

### Blocking `/kick` targeting

In `performKick`, add a больничка check in the same position/style as the existing `isHidden(target.id)` check (bot.js:1942-1945):

```js
if (isHospitalized(target.id)) {
  bot.sendMessage(chatId, `${targetLabel} лежит в больничке — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
  return;
}
```

### Auto-break on attack (attacker side)

`performKick`'s existing attacker-side `isKnockedOut(attacker.id)` hard-block is deleted. In its place, at the same spot where the existing `isHidden(attacker.id)` auto-break already lives (bot.js:1989-1992, right before `consumeEnergy`), add an больничка auto-break using the identical pattern:

```js
if (isHospitalized(attacker.id)) {
  db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(attacker.id);
  await bot.sendMessage(chatId, `🏥 ${actorLabel} выписывается из больнички, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
}
```

This runs regardless of current health (even well below 30) — attacking is always a valid, deliberate way to leave больничка early, at the cost of losing the faster regen and the protection from being targeted.

### Regen rate

`HEALTH_REGEN_PER_HOUR` (bot.js:3619, currently `10`) becomes `20`. This is a global baseline change requested alongside больничка, not scoped to hospitalized players only.

Add `HOSPITAL_REGEN_MULTIPLIER = 2` and apply it inside `healthRegenTick`'s existing per-user loop (bot.js:3631-3638) for any row with `hospitalized_since IS NOT NULL`:

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

This proactively clears `hospitalized_since` the moment a regen tick crosses the 30 HP line, so `/find`'s больничка listing (a direct query, not a per-user `isHospitalized` call — see below) never shows a stale entry between ticks longer than necessary. (`isHospitalized` itself still lazily self-corrects on any direct call regardless, as a second line of defense — e.g. between ticks.)

### Capacity

None. Unlike чулан's 5-slot eviction, больничка accepts everyone knocked out — no eviction logic needed.

### `/me` display

Alongside the existing chulan line (bot.js:1487-1490), add:

```js
if (isHospitalized(msg.from.id)) {
  const row = db.prepare('SELECT health FROM user_health WHERE user_id = ?').get(msg.from.id);
  lines.push(`🏥 В больничке (здоровье ${row.health}/${HOSPITAL_EXIT_HEALTH})`);
}
```

### `/find` display

Alongside the existing чулан bucket (bot.js:1590-1601), add a больничка bucket, listed first (most "off the board"):

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
    // ...unchanged existing branch...
  } else {
    visibleLines.push(`⚔️ ${label}`);
  }
}
const lines = ['Бойцы:', ...hospitalLines, ...hiddenLines, ...visibleLines];
```

### `/help` text

One new line, plus updating the existing больничка-adjacent `/kick` line's "0 здоровья — мут на 30 мин" fragment to reflect the new больничка behavior instead:

- `/kick`'s help text currently says `...0 здоровья — мут на 30 мин + если у жертвы было оружие...` — change to `...0 здоровья — попадает в больничку (недоступен для удара, регенерация ×2, пока не наберёт 30 ХП; может выйти раньше сам, атаковав) + если у жертвы было оружие...`.

---

## Part 2: Защитная стойка (`/defend`)

### Schema

Add one column to the existing `buffs` table (same `ALTER TABLE` idiom):

```js
for (const [column, def] of [['defend_until', 'INTEGER']]) {
  try { db.exec(`ALTER TABLE buffs ADD COLUMN ${column} ${def}`); } catch {}
}
```

### Constants

```js
const DEFEND_DURATION_MS = 30 * 60 * 1000;
const DEFEND_ENERGY_COST = 2;
const DEFEND_DODGE_BONUS = 25;
const DEFEND_DAMAGE_REDUCTION = 0.4; // incoming graduated damage ×(1 - 0.4)
```

### `isDefending(userId)`

Pure lazy read, no clearing needed (same idiom as `getHitThreshold`/`getCritThreshold` reading `*_until` columns):

```js
function isDefending(userId) {
  const row = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(userId);
  return !!row && row.defend_until > Math.floor(Date.now() / 1000);
}
```

### `/defend` command

No warrior gate (matches `kuniFun`/`kuniAlia`/`kuniTama`, none of which require `is_warrior`). Not chat-scoped (matches `/hide`, also not scoped to `ARENA_CHAT_ID`). Always succeeds once energy is paid — no 50/50 roll (unlike kuni buffs; this is "assume a stance," not an attempt that can fail):

```js
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

(Reuses `consumeEnergy`, same as every other energy-spending command.)

### Dodge bonus (defender side)

In `performKick`'s opposed-roll `defenderScore` calculation (bot.js:2019), add the defend bonus as an independent additive term alongside the existing dodge buff, agility, and leg-injury terms (stacks with an active kuni dodge buff — no need to prevent that, it's a rare combo and not worth special-casing):

```js
const defendDodgeBonus = isDefending(target.id) ? DEFEND_DODGE_BONUS : 0;
defenderScore = defenderRoll + dodgeBuffBonus + defendDodgeBonus + targetStats.agility * AGILITY_DODGE_PER_POINT - (targetInjury === 'leg' ? LEG_INJURY_DODGE_PENALTY : 0);
```

### Damage reduction (defender side)

Applies only to the same "graduated damage" branches that strength/arm-injury already modify — the generic non-carrot weapon branch, and carrot ear/nose/mouth. **Does NOT apply** to nat-100 (`roll === 100`) or carrot "ass" (both already documented as intentionally exact-value, unmodified-by-any-multiplier effects — this spec extends that same exclusion to the new defense-side multiplier for consistency, per explicit user confirmation).

Add a `defendFactor` term computed once per hit (alongside where `strengthFactor`/`armInjuryFactor` are already computed at bot.js:2058-2059), then multiply it into every graduated-damage `dmg` calculation the same way `strengthFactor`/`armInjuryFactor` already are:

```js
const defendFactor = isDefending(target.id) ? (1 - DEFEND_DAMAGE_REDUCTION) : 1;
```

Example for the carrot `ear` branch (bot.js:2084), showing the pattern to replicate at every graduated-damage site (ear, nose, and the generic non-carrot weapon branch further down):

```js
const dmg = Math.round(rawDmg * 0.8 * strengthFactor * armInjuryFactor * defendFactor);
```

### Auto-break on attack

Same position and pattern as больничка's and чулан's auto-break, in `performKick` right before `consumeEnergy`:

```js
if (isDefending(attacker.id)) {
  db.prepare('UPDATE buffs SET defend_until = NULL WHERE user_id = ?').run(attacker.id);
  await bot.sendMessage(chatId, `🛡️ ${actorLabel} опускает защиту, чтобы атаковать!`, threadOpts(msgLike)).catch(() => {});
}
```

All three auto-break checks (чулан, больничка, defend) end up sitting together in this one spot in `performKick`, each independent and each optional (a player could in principle be hospitalized AND defending AND hidden simultaneously going into this check — no mutual exclusion is enforced or needed; each clears independently if active).

### `/me` display

Alongside the existing чулан/больничка lines:

```js
if (isDefending(msg.from.id)) {
  const row = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  const minutesLeft = Math.ceil((row.defend_until - Math.floor(Date.now() / 1000)) / 60);
  lines.push(`🛡️ Защитная стойка (осталось ${minutesLeft} мин)`);
}
```

### `/help` text

One new line, placed near the other `kuni*` self-buff lines:

```js
'/defend — встать в защитную стойку на 30 мин: +25 к увороту, −40% входящего урона (только обычный урон, не нат.100/жопу морковкой); атака снимает стойку; тратит 2 энергии, кулдаун = сама стойка',
```

---

## Out of scope

- No troll-bot changes.
- No больничка capacity limit.
- No success-chance roll on `/defend` (always succeeds if energy is paid).
- No mutual exclusion between больничка, defend, and чулан — they can coexist; each has its own independent auto-break-on-attack.
- No change to the existing knockout-steal-buttons flow.
