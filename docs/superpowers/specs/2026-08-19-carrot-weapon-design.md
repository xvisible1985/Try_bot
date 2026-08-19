# «Морковка» (carrot weapon) — design

## Purpose

A 6th real, stealable weapon in the existing PvP system, seeded to
`@MashaZaykaaa`. Unlike every other real weapon (bat/axe/scissors/
crutch/horns), it has no single fixed damage multiplier — on a
successful `/kick` hit, one of 5 equally-likely "holes" is picked,
each with a different effect ranging from reduced damage to healing
the victim to an instant knockout. On top of whichever hole is hit,
the victim also gets a 20-minute `/cat` or `/fox` status (50/50).
Scope is `tg-bot`'s `/kick` only — troll-bot is not touched.

## Design

### Weapon definition and seeding

`WEAPON_DEFS.carrot` has no `multiplier` field (nothing generic reads
it — the damage/effect resolution is entirely special-cased for this
weapon, see below):

```js
carrot: { name: 'морковка', instrumental: 'морковкой', accusative: 'морковку', emoji: '🥕' },
```

Seed row uses the normal username-based lazy resolution, same as
`bat`/`axe`/`scissors`/`horns` (she has a public `@username`, unlike
Дима's `crutch` special-case):

```js
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('carrot', 'MashaZaykaaa', 'human', NULL, NULL)").run();
```

### Hole resolution (replaces the generic damage line for this weapon only)

In `/kick`, the existing block:

```js
const targetHealthBefore = getUserHealth(target.id);
const rawDmg = Math.floor(Math.random() * 20) + 1;
const dmg = Math.round(rawDmg * weapon.multiplier);
const targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
await bot.sendMessage(msg.chat.id, `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msg)).catch(() => {});
```

becomes an `if (weapon.key === 'carrot') { ... } else { <existing block, unchanged> }`. The carrot branch declares `let hole` (scoped
so the later crit block can read it — see below) and picks one of 5
outcomes with equal 20% probability each:

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
} else {
  const rawDmg = Math.floor(Math.random() * 20) + 1;
  const dmg = Math.round(rawDmg * weapon.multiplier);
  targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
  await bot.sendMessage(msg.chat.id, `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msg)).catch(() => {});
}
```

**Why "ass" calls `damageHuman` with `targetHealthBefore.health` as the
damage amount, instead of a separate direct health=0 write:** it goes
through the exact same floor-at-zero-and-mute path every other lethal
hit already uses, so the existing 30-minute mute AND the just-shipped
knockout-steal-buttons offer (triggered off `targetHealthAfter === 0`,
unchanged, further down in the handler) both fire automatically with
no special-casing needed there.

**Why "dick" writes health directly instead of calling `damageHuman`:**
`damageHuman` only ever subtracts (`MAX(0, health - damage)`); healing
needs the opposite clamp (`MIN(max_health, health + 20)`), so this is
a small inline UPDATE rather than a reused function — matching how
this file already does ad-hoc capped health writes for other regen
paths (e.g. `healthRegenTick`'s own `MIN(max_health, health + ?)`).

### 20-minute `/cat`/`/fox` status on any successful hit

After the hole resolves (regardless of which one — "ass" and "dick"
both count as much as the three damage holes), roll a coin flip and
apply a timed animal status:

```js
if (weapon.key === 'carrot') {
  const animalType = Math.random() < 0.5 ? 'cat' : 'fox';
  applyTimedAnimal(target.id, msg.chat.id, target.username || target.firstName, animalType);
  const animalMsg = animalType === 'cat'
    ? `🐱 ${targetLabel} на 20 минут теперь мяукает как кошка!`
    : `🦊 ${targetLabel} на 20 минут теперь рычит как лиса!`;
  await bot.sendMessage(msg.chat.id, animalMsg, threadOpts(msg)).catch(() => {});
}
```

(Message wording matches the user-approved draft exactly: cat says
"мяукает как кошка", fox says "рычит как лиса" — different verbs per
animal, not a shared template.)

**New `applyTimedAnimal` helper**, placed near the existing animal
helpers, mirrors `crutch`'s `applyDimon` precedent exactly — never
downgrades an existing PERMANENT animal status (admin-set via
`/pig`/`/cat`/`/fox`/`/dog`/`/cow`/`/donkey`, `animal_until IS NULL`)
to a timed one:

```js
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

**Schema:** `animals` gets one new nullable column, same ALTER idiom
as every other timed-status column in this file:

```js
try {
  db.exec('ALTER TABLE animals ADD COLUMN animal_until INTEGER');
} catch {}
```

**Existing admin commands (`/pig`, `/cat`, etc., `bot.js:1287-1289`)
are unchanged** — their `INSERT OR REPLACE INTO animals (user_id,
chat_id, username, animal, added_by, added_by_name)` never mentions
`animal_until`, so it stays `NULL` (permanent) exactly as today.

**Two existing read sites need a lazy-expiry check** — the sticker-OCR
branch (`bot.js:2065`, `const aRow = ...`) and the main text branch
(`bot.js:2089`, `const animalRow = ...`) — both currently `SELECT
animal FROM animals WHERE user_id = ?`. Each needs to also fetch
`animal_until` and, if it's set and in the past, delete the row and
treat the user as having no animal status for this message (same lazy
expire-on-read idiom used everywhere else in this file — injuries,
bleed, `crutch`'s `dimon_until`):

```js
const aRow = db.prepare('SELECT animal, animal_until FROM animals WHERE user_id = ?').get(msg.from.id);
if (aRow && aRow.animal_until && aRow.animal_until * 1000 < Date.now()) {
  db.prepare('DELETE FROM animals WHERE user_id = ?').run(msg.from.id);
}
const effectiveARow = (aRow && (!aRow.animal_until || aRow.animal_until * 1000 >= Date.now())) ? aRow : null;
```

(exact variable-naming approach is an implementation detail for the
plan — the important, non-negotiable part is that both read sites
gain the same expiry check, and that an expired row is deleted so it
doesn't linger and doesn't need re-checking on every future message.)

### Crit suppression on "ass"

The existing crit block (`if (roll >= getCritThreshold(msg.from.id))
{ ... }`, unconditional on weapon today) must NOT fire when this same
hit resolved to "ass" — that outcome's own effect (full wipe + mute +
steal offer) is already the maximum consequence a hit can have; a
stacked arm/leg/head injury and a second, independent crit-steal roll
on top would be redundant, per explicit user decision. The condition
becomes:

```js
if (roll >= getCritThreshold(msg.from.id) && !(weapon.key === 'carrot' && hole === 'ass')) {
  ...unchanged...
}
```

### `/me` display

`/me`'s weapon-listing loop (`bot.js:1053-1056`) currently prints
`${def.emoji} Ты держишь ${def.name}: урон ×${def.multiplier}` for
every held weapon — carrot has no such number, so it gets its own
branch:

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

## Out of scope

- troll-bot — this weapon only affects `tg-bot`'s `/kick`.
- Any change to the existing 5%-crit-steal (`maybeStealWeapon`) or the
  knockout-steal-buttons feature — both already correctly compose with
  this weapon with zero code changes to either (crit-steal simply
  doesn't run on an "ass" hit per the suppression above; the knockout
  offer fires automatically off `targetHealthAfter === 0` regardless
  of which weapon caused it).
- A dedicated `/help` line describing carrot's 5 outcomes in detail —
  matches this session's existing precedent that individual real
  weapons aren't enumerated in `/help` beyond the general `/kick` line
  (bat/axe/scissors/horns aren't named either; only `crutch`'s and now
  this weapon's *cross-cutting mechanics* — mute/steal-offer — are
  already covered by the general `/kick` line, not per-weapon).

## Testing

Manual only, matching this file's convention: `node --check bot.js`,
then an isolated `node -e` script verifying `applyTimedAnimal`'s
permanent-status-protection branch and the two read sites' lazy-expiry
logic against a scratch in-memory DB (mirroring how `crutch`'s
`applyDimon` was verified), then a live smoke test — land enough hits
with the carrot to observe all 5 holes, confirm damage math for
ear/nose/mouth, confirm the heal-and-no-damage "dick" outcome, confirm
"ass" produces a full wipe + mute + the knockout-steal buttons appear,
confirm cat/fox status applies and expires after 20 minutes, confirm
an admin-set permanent animal status survives a carrot hit unchanged,
and confirm `/me` shows the carrot's descriptive line instead of a
multiplier.
