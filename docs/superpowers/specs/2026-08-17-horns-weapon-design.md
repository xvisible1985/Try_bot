# «Рога» (horns weapon) — design

## Purpose

A fifth real, stealable weapon in the existing PvP weapon system
(alongside `bat`/`axe`/`scissors`/`crutch`), seeded to `@Tamasvi_Vamp`.

- Damage multiplier: `×2` (between `bat` at 1.5 and `axe`/`scissors`-tier
  effects — its own tier, no other weapon currently uses `×2`).
- On a critical hit only (the existing `roll >= 90` crit/injury
  threshold — not on every successful hit) an extra flavor line is
  appended to the existing crit message: `🐂 {actorLabel} насадила
  {targetLabel} на рога!`
- No new game mechanic, table, or helper function — purely
  `WEAPON_DEFS` + a `weapon_ownership` seed row + one extra line inside
  the existing crit branch at each of the 6 combat call sites (same
  branch that already handles injury + weapon-steal-on-crit).
- Works everywhere the other real weapons work: `tg-bot`'s `/kick`,
  and — if stolen — `troll-bot`'s `/fight` and all four
  autonomous-attack functions.

## Design

### Weapon definition

Added to `WEAPON_DEFS` in **both** `tg-bot/bot.js` and
`troll-bot/bot.js`:

```js
horns: { name: 'рога', instrumental: 'рогами', accusative: 'рога', multiplier: 2, emoji: '🐂' },
```

### Ownership seeding

Unlike `crutch` (Дима, no `@username`), `@Tamasvi_Vamp` has a normal
public username, so this follows the exact same lazy-resolution
pattern as `bat`/`axe`/`scissors`:

```js
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('horns', 'Tamasvi_Vamp', 'human', NULL, NULL)").run();
```

(In `troll-bot`, the equivalent seed uses `tgBotDb.prepare(...)`, same
as its existing seed rows.) `owner_user_id`/`owner_username` are
resolved automatically the next time she sends a message, via the
existing generic `UPDATE weapon_ownership SET owner_user_id = ?,
owner_username = ? WHERE seed_username = ? AND owner_type = 'human'
AND owner_user_id IS NULL` resolution already in place for the other
username-seeded weapons — no new resolution code needed.

### Trigger — crit only, everywhere the weapon can be swung

Unlike `scissors`'/`crutch`'s "any successful hit" trigger, this is
gated on the same `roll >= 90` (or that site's equivalent crit check,
e.g. `swing.roll >= 90`/`critRoll >= 90`) branch that already handles
injury + weapon-steal-on-crit. One extra line, added right after
that branch's existing injury message, at each site:

```js
if (weapon.key === 'horns') {
  await bot.sendMessage(msg.chat.id, `🐂 ${actorLabel} насадила ${targetLabel} на рога!`, threadOpts(msg)).catch(() => {});
}
```

(tg-bot's `/kick` shown; troll-bot's 5 call sites follow the same
shape as their neighboring injury-message code, using that site's own
`actorLabel`/`targetLabel`-equivalent variables and
`await`/no-`await` convention, same as `crutch`'s wiring.)

Placement: inside the existing crit branch (`if (roll >= 90) { ... }`
or equivalent), after the injury message and before/after the
weapon-steal check — order relative to weapon-steal doesn't matter
since they're independent message sends; placing it right after the
injury message (before the weapon-steal check) keeps it visually
grouped with "what happened on this crit" before "oh, and a weapon
changed hands."

**Grammar note:** `насадила` (feminine) is fixed flavor text tied to
this specific weapon and its current owner, same category of
person-specific fixed narrative as the `/kuniFun`-style flavor
messages elsewhere in this file (which already hardcode a similar
fixed verb form) — not meant to grammatically generalize if the
weapon changes hands via the existing steal mechanic. This mirrors
this codebase's existing precedent, not a regression.

## Out of scope

- Any new status effect, table, or helper — this weapon only adds a
  crit-triggered flavor line, no persistent state beyond the existing
  `weapon_ownership` row.
- Changing the crit threshold, roll mechanic, or the existing
  injury/weapon-steal logic at any call site — the horns message is
  purely additive.
- A grammatically-agreeing verb if the weapon is stolen by a
  differently-gendered attacker — accepted, matches existing
  precedent elsewhere in this file (see Grammar note above).

## Testing

Manual only, matching this file's convention: `node --check bot.js` in
both repos, then a live smoke test — land a crit with the horns
equipped and confirm the extra flavor line appears alongside the
existing injury/weapon-steal messages, in both `/kick` and (if
stolen) troll-bot's combat.
