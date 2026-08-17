# «Костыль» (crutch weapon) — design

## Purpose

A fourth real, stealable weapon in the existing PvP weapon system
(alongside `bat`/`axe`/`scissors`), seeded to the user "Димка"
(Telegram user id `736180284` — he has no public `@username`, so the
usual seed-by-username lazy resolution doesn't apply here; his
`weapon_ownership` row is seeded with the id already known).

- Damage multiplier: `×1.25` (same tier as scissors).
- On any successful hit (not crit-gated — same trigger condition as
  scissors' bleed): the victim is put into the existing "old man
  Dimon" status (`dimoniacs` table, already used by the admin-only
  `/dimon`/`/undimon` commands) for **2 hours**, after which it lifts
  automatically.
- Works everywhere the other three real weapons work: `tg-bot`'s
  `/kick`, and — if stolen — `troll-bot`'s `/fight` and all four
  autonomous-attack functions, matching the bat/axe/scissors precedent.

## Design

### Weapon definition

Added to `WEAPON_DEFS` in **both** `tg-bot/bot.js` and
`troll-bot/bot.js` (duplicated verbatim, same as `bat`/`axe`/`scissors`):

```js
crutch: { name: 'костыль', instrumental: 'костылём', accusative: 'костыль', multiplier: 1.25, emoji: '🩼' },
```

### Ownership seeding

`weapon_ownership` lives in `tg-bot`'s DB (owned there, read/written
cross-process by `troll-bot` via `tgBotDb`, same as the other three
weapons). Because Димка has no `@username`, the existing lazy
resolution (`seed_username` matched against a live `msg.from.username`
the next time he types) can't apply — instead the row is seeded with
`owner_user_id` already populated, skipping resolution entirely:

```js
db.prepare(
  "INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('crutch', NULL, 'human', 736180284, NULL)"
).run();
```

(In `troll-bot`, the equivalent seed uses `tgBotDb.prepare(...)`, same
as its existing bat/axe/scissors seed rows.)

Because `owner_user_id` is non-NULL from the start, the existing lazy
resolution `UPDATE ... WHERE seed_username = ? AND owner_user_id IS
NULL` (tg-bot's `bot.js:1735` today) never touches this row — no
interference with the other three weapons' resolution flow.

### Timed "Dimon" status

`dimoniacs` (tg-bot only — this is the table the old-man-speech
message hook reads) gets one new nullable column, added via the same
`ALTER TABLE` idiom used for `user_health.hidden_until`/`energy`:

```js
try {
  db.exec('ALTER TABLE dimoniacs ADD COLUMN dimon_until INTEGER');
} catch {}
```

`dimon_until IS NULL` means **permanent** (admin-set via `/dimon`,
unchanged behavior — `/dimon`'s existing `INSERT OR REPLACE` continues
to omit this column, so it stays NULL). A non-NULL value means
**timed** — set by a crutch hit, unix-seconds expiry.

New helper, placed near `getUserInjury`/`applyBleed`:

```js
// Weapon-triggered "old man Dimon" status — 2 hours, auto-expires (see
// the message hook's lazy dimon_until check). Never downgrades an
// existing PERMANENT status (dimon_until IS NULL, set by admin /dimon)
// to a timed one — a crutch hit can't undo an admin's manual punishment.
function applyDimon(userId, chatId, username) {
  const existing = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = ?').get(userId);
  if (existing && existing.dimon_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 2 * 3600;
  db.prepare(
    'INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dimon_until = excluded.dimon_until, message_count = 0, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, until);
}
```

The old-man-speech message hook (`bot.js:1847` today) gains a lazy
expiry check, same pattern as `getUserInjury`'s `injured_until` check —
read `dimon_until` alongside `message_count`, and if it's set and in
the past, delete the row and skip the effect instead of applying it:

```js
const dimonRow = db.prepare('SELECT message_count, dimon_until FROM dimoniacs WHERE user_id = ?').get(msg.from.id);
if (dimonRow && dimonRow.dimon_until && dimonRow.dimon_until * 1000 < Date.now()) {
  db.prepare('DELETE FROM dimoniacs WHERE user_id = ?').run(msg.from.id);
} else if (dimonRow && msg.text && !msg.text.startsWith('/') && !msg.text.startsWith('**')) {
  // ...existing message_count increment + old-man-phrase logic, unchanged...
}
```

`troll-bot` gets a thin cross-process wrapper, same shape as its
existing `applyBleed` (`troll-bot/bot.js:251`):

```js
function applyDimon(userId, chatId, username) {
  if (!tgBotDb) return;
  const existing = tgBotDb.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = ?').get(userId);
  if (existing && existing.dimon_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 2 * 3600;
  tgBotDb.prepare(
    'INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dimon_until = excluded.dimon_until, message_count = 0, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, until);
}
```

(The old-man-speech message hook itself only exists in `tg-bot`, since
that's the bot that intercepts humans' own chat messages — `troll-bot`
only ever needs to *write* the status via `applyDimon`, same
write-only relationship it already has with `applyBleed`.)

### Trigger — everywhere the weapon can be swung

Same unconditional-on-hit trigger as scissors' bleed (not crit-gated),
placed as a sibling `if (weapon.key === 'crutch')` block right next to
each existing `if (weapon.key === 'scissors')` block:

- `tg-bot/bot.js`'s `/kick` handler (next to `bot.js:1119`)
- `troll-bot/bot.js`'s `performFight` (next to `bot.js:2169`)
- `troll-bot/bot.js`'s `performDrink` (next to `bot.js:2372`)
- `troll-bot/bot.js`'s `triggerDrunkAttack` (next to `bot.js:2701`)
- `troll-bot/bot.js`'s `triggerFasAttack` (next to `bot.js:2778`)
- `troll-bot/bot.js`'s `triggerFoodSteal` (next to `bot.js:2915`)

Each site's block (tg-bot example; troll-bot sites follow the same
shape as their neighboring scissors block, using that site's own
`targetLabel`/`name` variable and non-`await`/`await` convention):

```js
if (weapon.key === 'crutch') {
  applyDimon(target.id, msg.chat.id, target.username);
  await bot.sendMessage(msg.chat.id, `🩼 ${targetLabel} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`, threadOpts(msg)).catch(() => {});
}
```

## Out of scope

- Changing `/dimon`/`/undimon`'s own admin-facing behavior — both stay
  exactly as they are today (permanent, `dimon_until` stays NULL).
- Any UI to see remaining Dimon-status time (matches this session's
  existing precedent of not surfacing buff/status countdowns outside
  of re-running the triggering action).
- A "steal-immune" or crit-gating rule for the crutch — it follows the
  exact same steal-on-crit and hit-gating conventions as the other
  three weapons.

## Testing

Manual only, matching this file's convention: `node --check bot.js` in
both repos, then an isolated `node -e` scratch-DB script verifying
`applyDimon`'s "don't downgrade a permanent status" branch and the
message hook's lazy-expiry branch, then a live smoke test — get hit by
the crutch, confirm the Dimon phrases start appearing, confirm they
stop appearing after the 2-hour window (or a temporarily shortened
window during manual testing) without an admin needing to run
`/undimon`.
