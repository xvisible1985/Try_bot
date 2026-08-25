# Платная больничка Design

**Repo:** tg-bot only (`bot.js`). No troll-bot changes (consistent with больничка's original scoping — troll-bot's own knockout handling is untouched either way).

**Goal:** Больничка entry now costs the victim 1 coin. If they can't pay, they're not hospitalized at all — instead the OLD flat 30-minute mute-based knockout (deleted when больничка originally shipped) applies, reviving `isKnockedOut()` as a hard attack-block. Separately, больничка's existing "attack to leave early" mechanic now requires ≥5 HP — below that, the attack is refused outright and больничка status is untouched.

## 1. Больничка entry becomes coin-gated

`damageHuman` (the single function that floors health to 0 and currently always sets `hospitalized_since`) tries to charge 1 coin first, atomically:

```js
if (row.health === 0) {
  const paid = db.prepare('UPDATE pvp_stats SET coins = coins - 1 WHERE user_id = ? AND coins >= 1 RETURNING coins').get(userId);
  if (paid) {
    db.prepare('UPDATE user_health SET hospitalized_since = COALESCE(hospitalized_since, ?) WHERE user_id = ?').run(now, userId);
  } else {
    muteUser(userId, chatId, username, 0, 'драка', 30 * 60 * 1000);
  }
}
```

A missing `pvp_stats` row (shouldn't happen in practice — reaching `damageHuman` at 0 HP always implies a warrior, who always has a row — but handled safely regardless) behaves the same as 0 coins: the guarded `UPDATE ... WHERE coins >= 1` simply matches 0 rows, `paid` is falsy, falls through to the mute branch.

## 2. `isKnockedOut()` is revived, verbatim

Больничка's own earlier implementation plan deleted this function and its one call site. It's restored exactly as it was before that deletion (retrieved from git history, commit `c533ce7`):

```js
// Whether an attacker is still within their post-knockout mute (see
// damageHuman's muteUser(..., 'драка', 30 min) call below — only reached
// when больничка couldn't be paid for, see the paid-hospital design).
// /kick used to gate on health === 0 directly, but healthRegenTick's
// hourly trickle can bring health back above 0 within as little as 10
// minutes — well before the intended 30-minute "в отключке" window ends
// — which let a just-regenerated attacker swing again with no warning.
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

`performKick` gets a new hard block, right after `attackerHealth = getUserHealth(attacker.id);` (same spot it originally lived, before больничка replaced it):

```js
if (isKnockedOut(attacker.id)) {
  bot.sendMessage(chatId, `${actorLabel}, твоя в отключке, какая драка!`, threadOpts(msgLike)).catch(() => {});
  return;
}
```

This is a genuine hard block (unlike больничка's own attacker handling, which allows attacking and ejects early) — matches the original pre-больничка behavior exactly, since a player muted this way was never admitted to больничка in the first place and has nothing to "leave."

## 3. Knockout announcement becomes conditional

`performKick`'s knockout-loot block currently posts an unconditional "🏥 ... попадает в больничку" message. It's now conditional on whether `damageHuman` actually hospitalized the victim (checked via `isHospitalized(target.id)` immediately after, which correctly reflects whichever branch `damageHuman` took):

```js
if (targetHealthAfter === 0) {
  if (isHospitalized(target.id)) {
    await bot.sendMessage(
      chatId,
      `🏥 ${targetLabel} без сознания и попадает в больничку (−1 монета из кошелька) — недоступен для удара, пока не наберёт ${HOSPITAL_EXIT_HEALTH} ХП (или сам не решит атаковать раньше, если наберётся хотя бы 5 ХП).`,
      threadOpts(msgLike)
    ).catch(() => {});
  } else {
    await bot.sendMessage(
      chatId,
      `😵 ${targetLabel} без сознания, но денег на больничку нет — остаётся на улице, замьючен(а) на 30 мин (не может атаковать).`,
      threadOpts(msgLike)
    ).catch(() => {});
  }
  // ...existing weapon/coin loot-offer logic, unchanged — applies
  // regardless of which branch above fired, same as today.
}
```

The loot offer (steal weapon / rob wallet) itself is untouched — it already fires purely off `targetHealthAfter === 0`, independent of больничка/mute state, and stays that way.

## 4. Больничка's early-exit now requires ≥5 HP

A new hard gate, placed right after the revived `isKnockedOut` check (so both "can't act at all" cases sit together, before the existing `isStunned`/energy checks):

```js
if (isHospitalized(attacker.id) && attackerHealth.health < HOSPITAL_MIN_DISCHARGE_HEALTH) {
  bot.sendMessage(chatId, `${actorLabel}, слишком слаб для драки — нужно хотя бы ${HOSPITAL_MIN_DISCHARGE_HEALTH} ХП, чтобы выписаться из больнички.`, threadOpts(msgLike)).catch(() => {});
  return;
}
```

New constant alongside `HOSPITAL_EXIT_HEALTH`/`HOSPITAL_REGEN_MULTIPLIER`:

```js
const HOSPITAL_MIN_DISCHARGE_HEALTH = 5;
```

The EXISTING attacker-side auto-break (further down in `performKick`, right before `consumeEnergy`) needs no change — by the time execution reaches it, this new early gate has already guaranteed that any still-hospitalized attacker has ≥5 HP, so the auto-break's unconditional eject remains correct as-is.

## Stale comment to fix

Больничка's final review (commit `2bbe080`) updated a comment in the main message handler's `isMuted` branch, noting the `'драка'`-mute flavor line was "now only reachable via a troll-bot-caused knockout" since tg-bot's own `/kick` no longer wrote that mute. That's no longer true once this ships — tg-bot's own `damageHuman` writes it again for the no-coins fallback. Find (search `only ever reached via a troll-bot-caused`) and revert/update that comment to reflect both sources again.

## Out of scope

- No troll-bot changes.
- The knockout-loot offer (weapon/coin theft) is unaffected either way — it doesn't care whether the victim ended up hospitalized or old-mute'd.
- No change to больничка's regen rate, target-side block, or any other больничка mechanic beyond what's described above.
- No refund of the 1 coin under any circumstance (leaving больничка early, natural recovery, etc.) — it's a flat entry cost, spent regardless of how the stay ends.
