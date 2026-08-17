# `/kuniFun`, `/kuniAlia`, `/kuniTama` — design

## Purpose

Three new public (non-admin) self-buff commands, usable by anyone on
themselves — no reply, no `@username`, no real target lookup. Each is a
flavor action ("{caller} сделал куни &lt;fixed name&gt;...") that grants the
caller a temporary combat buff affecting `/kick`:

- `/kuniFun` — +50% crit/injury chance, 10 minutes.
- `/kuniAlia` — +50% dodge chance (harder to be hit), 10 minutes.
- `/kuniTama` — +25% crit/injury AND +25% dodge simultaneously, 10 minutes.

Scope is `tg-bot/bot.js` only, affecting `/kick` only. troll-bot is
untouched — no `/fight` or autonomous-attack interaction.

## Design

### Storage

One new table, created next to `injuries`/`health_regen_state` (same
`CREATE TABLE IF NOT EXISTS` idiom):

```sql
CREATE TABLE IF NOT EXISTS buffs (
  user_id INTEGER PRIMARY KEY,
  crit_mult REAL,
  crit_until INTEGER,
  dodge_mult REAL,
  dodge_until INTEGER,
  fun_cd_until INTEGER,
  alia_cd_until INTEGER,
  tama_cd_until INTEGER
)
```

All `*_until`/`*_cd_until` columns are unix-seconds timestamps, same
convention as `injuries.injured_until`/`user_health.bleed_until`
elsewhere in this file (`Math.floor(Date.now() / 1000)` for "now",
compared as `until * 1000 > Date.now()`).

Two independent "slots": **crit** (written by `/kuniFun` or
`/kuniTama`) and **dodge** (written by `/kuniAlia` or `/kuniTama`).
`crit_mult`/`dodge_mult` hold `1.5` or `1.25` — used only to pick a
threshold at roll-resolution time, not applied as arithmetic multipliers.

### Cooldowns

Each of the three commands has its own independent cooldown, equal to
the buff duration (10 minutes), tracked in its own `*_cd_until` column.
While a command is on cooldown, re-running it replies "бафф уже
активен" and does nothing else. Cooldowns are independent per command —
e.g. `/kuniTama` being on cooldown does not block `/kuniFun`.

Because a command's cooldown always matches its own buff's duration,
"on cooldown" and "this command's buff is currently active" are the
same condition in practice — no separate cooldown bookkeeping needed
beyond checking the buff-relevant `*_until`/`*_mult` pair for that
command's slot(s).

### Stacking

Crit and dodge are independent slots, so `/kuniFun` + `/kuniAlia` can
both be active on the same user at once. `/kuniTama` writes to both
slots at once, unconditionally overwriting whatever was there —
including a stronger `/kuniFun`/`/kuniAlia` value, if the caller
chooses to cast it while one is still running. This is an accepted
edge case, not worth extra "keep the stronger" logic.

### Success roll (50/50)

After the cooldown check passes (command isn't already on cooldown),
each command rolls once, same convention as `/kick`:
`roll = Math.floor(Math.random() * 101)`, success at `roll >= 50`.

**The cooldown is started either way** — on both success and failure,
the command's own `*_cd_until` is set to `now + 600`. A failed roll
still "used up" the attempt; there's no free instant retry. This means
each buff's effective uptime is now roughly half of what it was before
this change (a cast has to actually succeed to grant 10 minutes of
buff, and every cast — success or fail — blocks the next attempt for
10 minutes).

- **On success:** identical to today — the relevant buff column(s) are
  set, and the flavor message is sent with the roll appended, e.g.
  `"{actorLabel} сделал куни InternalFun и теперь стал более опасен ⚡
  (+крит на 10 мин): 68/100"`.
- **On failure:** the buff columns (`crit_mult`/`crit_until`,
  `dodge_mult`/`dodge_until`) are **not** touched — only that command's
  `*_cd_until` is written, via an `INSERT ... ON CONFLICT DO UPDATE SET
  <cd_column> = excluded.<cd_column>` that omits the mult/until
  columns entirely (so an existing buff from an earlier successful
  cast, if still running, is left alone — a failed re-cast can't
  cancel a buff that's already active). Message: `"{actorLabel}
  попытался сделать куни InternalFun, но не вышло 😅 (30/100)"`.

### Commands

Placed together as a new block, after the existing `/kick` handler and
before `/heal` (matching the file's existing practice of grouping
related commands). Each follows the same shape:

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

`/kuniAlia` is the same shape (own cooldown check with the same
"ещё N мин" wording, own roll), writing `dodge_mult = 1.5, dodge_until`,
`alia_cd_until` on success. Success message: `"{actorLabel} сделал
куни AliyaKuzAli и теперь лучше уклоняется 🌀 (+уклонение на 10 мин):
{roll}/100"`. Failure message: `"{actorLabel} попытался сделать куни
AliyaKuzAli, но не вышло 😅 ({roll}/100)"` (only `alia_cd_until` written).

`/kuniTama` writes all four buff columns (`crit_mult = 1.25`,
`dodge_mult = 1.25`, both `_until`, and `tama_cd_until`) on success,
same cooldown-check and roll shape. Success message: `"{actorLabel}
сделал куни Tama и теперь стал опаснее и увёртливее ✨ (+крит и
+уклонение на 10 мин): {roll}/100"`. Failure message: `"{actorLabel}
попытался сделать куни Tama, но не вышло 😅 ({roll}/100)"` (only
`tama_cd_until` written).

### `/kick` roll resolution

Two new helper functions, placed near `getUserInjury`/`getUserHealth`:

```js
function getCritThreshold(userId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT crit_mult, crit_until FROM buffs WHERE user_id = ?').get(userId);
  if (row && row.crit_until > now) return row.crit_mult >= 1.5 ? 84 : 87;
  return 90;
}

function getHitThreshold(targetId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT dodge_mult, dodge_until FROM buffs WHERE user_id = ?').get(targetId);
  if (row && row.dodge_until > now) return row.dodge_mult >= 1.5 ? 75 : 62;
  return 50;
}
```

In the `/kick` handler (`bot.js:1061-1089`):

- `const roll = Math.floor(Math.random() * 101);`
- `const success = roll >= getHitThreshold(target.id);` (was `roll >= 50`)
- `if (roll >= getCritThreshold(msg.from.id)) { ... }` (was `roll >= 90`)

### Threshold math (why these numbers)

Base roll is 0–100 (101 values). Base hit chance `roll >= 50` is
51/101 ≈ 50.5%; base crit chance `roll >= 90` is 11/101 ≈ 10.9%.

| Command | Effect | Threshold | Resulting chance | vs. base |
|---|---|---|---|---|
| `/kuniFun` | +50% crit | `roll >= 84` | 17/101 ≈ 16.8% | ×1.54 |
| `/kuniAlia` | +50% dodge | attacker needs `roll >= 75` | defender's dodge ≈ 74.3% | ×1.50 |
| `/kuniTama` | +25% crit | `roll >= 87` | 14/101 ≈ 13.9% | ×1.27 |
| `/kuniTama` | +25% dodge | attacker needs `roll >= 62` | defender's dodge ≈ 61.4% | ×1.24 |

("Dodge" isn't a separate roll — it's expressed as raising the
threshold the *attacker's* roll must clear against a buffed defender,
since `/kick` only ever rolls once per attack.)

## Out of scope

- troll-bot / `/fight` / autonomous troll attacks — buffs only affect
  `tg-bot`'s `/kick`.
- Any resource cost (energy, etc.) beyond the per-command cooldown.
- "Keep the stronger buff" logic when `/kuniTama` overwrites an active
  `/kuniFun`/`/kuniAlia` — simple overwrite is accepted behavior.
- Admin controls / moderation — these are public commands with no gate,
  same as the user's explicit request.

## Testing

Manual only, matching this file's convention: `node --check bot.js`,
then live smoke test — cast each command enough times to see both a
success and a failure, confirm the right message/roll appears in each
case, confirm a failure still starts the 10-minute cooldown (immediate
re-cast is blocked) and doesn't touch an already-active buff from an
earlier success, and confirm a success still applies the buff and lets
`/kick` show elevated win/crit rates as before. The isolated-DB-logic
scratch scripts from the original plan remain valid for the
unconditional parts (threshold lookup, stacking) since this change
only adds a branch before the existing insert, not new tables/columns.
