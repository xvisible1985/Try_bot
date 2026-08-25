# Нож как множественный предмет + магазин оружия Design

**Repo:** tg-bot only (`bot.js`). No troll-bot changes (troll-bot never holds knives — `weapon_ownership.owner_type='troll'` is used by other weapons, knife has never been assignable to the troll).

**Goal:** Multiple knives can exist simultaneously, each independently owned and independently decaying 3 hours after ITS OWN acquisition. A single player can hold several at once. `/shop`'s weapon category sells a knife for 5 coins; any owned knife (from `/pick` or the shop) can be sold back for 3 coins.

## Why this is a real refactor, not an add-on

Today `weapon_ownership` has `weapon_key TEXT PRIMARY KEY` — structurally, at most one row can ever exist per weapon type, so `weapon_key` alone is already a unique identifier for "the one bat," "the one axe," etc. Every place that steals, gives, drops, or picks up a weapon relies on this — none of them reference a row id, they all just filter by `weapon_key`. Knife needs to escape this constraint while the other six weapons (bat/axe/scissors/crutch/horns/carrot) keep it exactly as-is — nothing about them changes.

## Schema

Knife moves into its own dedicated table. `weapon_ownership` keeps its existing 6 weapons untouched; its `'knife'` seed row is retired (one-time migration, see below).

```sql
CREATE TABLE IF NOT EXISTS owned_knives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  owner_username TEXT,
  is_dropped INTEGER NOT NULL DEFAULT 0,
  dropped_chat_id INTEGER,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)
```

Each row is one physical knife. `is_dropped`/`dropped_chat_id` mirror `weapon_ownership`'s existing fumble-drop convention exactly: on a fumble, `owner_user_id` is repurposed to "who dropped it" (so they can't immediately re-pick their own), `is_dropped=1`, `dropped_chat_id` set; on pickup, reversed.

One-time migration (the established `runOnce` pattern), retiring the old singleton row — if a knife is currently actively held when this ships, it's carried over as a fresh `owned_knives` row so nobody loses an in-progress knife on deploy:

```js
runOnce('2026-08-25-knife-multi-instance-migration', () => {
  const existing = db.prepare("SELECT owner_user_id, owner_username, expires_at FROM weapon_ownership WHERE weapon_key = 'knife' AND owner_type = 'human'").get();
  if (existing) {
    db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)')
      .run(existing.owner_user_id, existing.owner_username, Math.floor(Date.now() / 1000), existing.expires_at);
  }
  db.prepare("DELETE FROM weapon_ownership WHERE weapon_key = 'knife'").run();
});
```

(A fumble-dropped-but-unclaimed knife at migration time is intentionally not carried over — an edge case not worth the extra complexity; it simply ceases to exist, same as if it had fully decayed.)

## The "instance key" abstraction

Every place that currently identifies a weapon by bare `weapon_key` (steal buttons, `/give`, fumble-drop/pickup, `/kick` slot picking) needs to keep working unchanged for the 6 singleton weapons while gaining the ability to name one SPECIFIC knife among several. Solution: an `instanceKey` string, computed alongside `weapon_key` everywhere weapons are listed:

- Singleton weapon → `instanceKey === weapon_key` (e.g. `"bat"`) — behaviorally identical to today, since it's still globally unique.
- Knife → `instanceKey === "knife:" + id` (e.g. `"knife:17"`).

`getWeaponsFor(ownerType, ownerUserId)` is the single place that produces this pairing, so every consumer downstream just uses whichever `instanceKey` it was handed — none of them need to know knife is special beyond "does this instanceKey start with `knife:`":

```js
function getWeaponsFor(ownerType, ownerUserId) {
  if (ownerType === 'troll') {
    return db.prepare("SELECT weapon_key, weapon_key AS instanceKey FROM weapon_ownership WHERE owner_type = 'troll' ORDER BY rowid").all();
  }
  const regular = db.prepare(
    "SELECT weapon_key, weapon_key AS instanceKey FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
  ).all(ownerUserId);
  const knives = db.prepare(
    "SELECT id, expires_at FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now') ORDER BY id"
  ).all(ownerUserId).map(row => ({ weapon_key: 'knife', instanceKey: `knife:${row.id}`, expiresAt: row.expires_at }));
  return [...regular, ...knives];
}
```

(Regular weapons first in stable `rowid` order as today, knives appended after in acquisition order — a simple, deterministic choice; there's no existing requirement for cross-type chronological interleaving.)

`pickWeaponForAttacker` (used by `/kick`/`/kick1/2/3`) passes the picked row's `instanceKey` through into the `weapon` object it returns, so `performKick`'s fumble-drop logic knows exactly which physical item to drop, not just which type.

## Every call site that needs the instanceKey branch

Each of these gets a two-way branch: `instanceKey.startsWith('knife:')` → operate on `owned_knives` by extracted numeric id; else → existing `weapon_ownership` logic, completely unchanged, just now keyed by `instanceKey` (which equals `weapon_key` for these, so behavior is identical).

1. **Fumble drop** (`performKick`, `roll === 0 && weapon.key`): knife branch does `UPDATE owned_knives SET owner_user_id = ?, owner_username = NULL, is_dropped = 1, dropped_chat_id = ? WHERE id = ?` (attacker id, chat id, extracted knife id).
2. **Fumble pickup** (main message handler's dropped-weapon listener): scans `owned_knives WHERE is_dropped = 1 AND dropped_chat_id = ? AND owner_user_id != ?` the same way it already scans `weapon_ownership`, claims via `UPDATE owned_knives SET owner_user_id = ?, owner_username = ?, is_dropped = 0, dropped_chat_id = NULL WHERE id = ? AND is_dropped = 1 AND dropped_chat_id = ?`.
3. **Knockout-loot steal offer** (`performKick`'s knockout block + `steal_yes:` callback): `callback_data` carries `instanceKey` instead of bare `weapon_key` (`steal_yes:${attacker.id}:${target.id}:${instanceKey}`). The callback's re-verify + transfer branches on the instanceKey prefix — knife case re-verifies/transfers a specific `owned_knives.id`; non-knife case is the existing code, unchanged in behavior.
4. **`/give`'s weapon transfer** (`gv_i:`/`gv_y:`/`gv_n:`): `itemType` becomes `weapon:<instanceKey>` instead of `weapon:<weapon_key>`. Same branch shape as #3 in both the `gv_i:` availability check and the `gv_y:` actual transfer.
5. **`/pick`'s knife branch**: instead of an `UPDATE ... WHERE weapon_key = 'knife'`, it's now a plain `INSERT INTO owned_knives (...)` — a brand new row every time, no shared-singleton race to guard against anymore. This is strictly simpler than before.
6. **`arenaTick`'s decay check**: iterates every `owned_knives` row with `is_dropped = 0` (matching the current `owner_type = 'human'` filter's exact semantics — a fumble-dropped-and-unclaimed knife does NOT decay while lying unclaimed, same quirk as today, intentionally preserved rather than "fixed," to keep this refactor behavior-preserving beyond the core singleton→multi-instance change) whose `expires_at` has passed, and `DELETE`s each expired row (no more "revert to `owner_type='none'`" state needed — a decayed knife simply stops existing, which is exactly what deleting the row means).
7. **`arenaTick`'s crate-drop composition**: the "only offer a knife crate if none currently exists" gate is removed entirely — since any number of knives can now coexist, the crate batch is unconditionally `['health_elixir', 'health_elixir', 'energy_elixir', 'energy_elixir', 'knife']` every time, same as it would have been if the original scarcity constraint had never existed. This also deletes the now-obsolete "only 1 knife ever exists" comment block.
8. **`/me`'s weapon display loop**: knife rows now show remaining time (a gap that existed even before this refactor — `/me` never surfaced the knife's expiry at all). Uses the `expiresAt` field `getWeaponsFor` now returns for knife rows:
```js
if (row.weapon_key === 'knife') {
  lines.push(`${def.emoji} ${slotTag} — ${def.name}: урон ×${def.multiplier} (осталось ${formatExpire(row.expiresAt)})`);
} else if (row.weapon_key === 'carrot') {
  ...
} else {
  ...
}
```
(`formatExpire` is an existing helper already used elsewhere for other expiry displays — e.g. чулан.)

`/warriors`' weapon-icon line is unaffected — it only ever reads `row.weapon_key` for the emoji, never needed per-instance identity, and multiple knives held by one warrior will now correctly show the knife emoji multiple times in a row (since `getWeaponsFor` returns one row per physical knife) — a natural, desirable side effect, not something that needs special handling.

## `/shop`'s weapon category

Second functional shop category, replacing the current `shop:soon` placeholder for "Оружие":

- `shop:weapons` — opens a small sub-menu: "Купить ржавый нож (5 монет)" / "Продать ржавый нож (3 монеты)" / "Назад". Shows current coin balance and how many knives the clicker currently holds.
- `shop:buy:knife` — guarded coin debit (5), then `INSERT INTO owned_knives` (same shape as `/pick`'s knife branch: `acquired_at = now`, `expires_at = now + 3*3600`, `is_dropped = 0`).
- `shop:sell:knife` — sells the OLDEST currently-held, non-dropped, non-expired knife (deterministic choice when a player owns several): look up its id, `DELETE` that row, credit 3 coins. If no knife to sell, `answerCallbackQuery` alert "Нечего продать".

```js
if (data === 'shop:buy:knife') {
  const paid = db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
  if (!paid) return bot.answerCallbackQuery(query.id, { text: 'Не хватает монет', show_alert: true }).catch(() => {});
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)')
    .run(userId, query.from.username, now, now + 3 * 3600);
  // ...re-render weapon sub-menu
}
if (data === 'shop:sell:knife') {
  const oldest = db.prepare("SELECT id FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now') ORDER BY id LIMIT 1").get(userId);
  if (!oldest) return bot.answerCallbackQuery(query.id, { text: 'Нечего продать', show_alert: true }).catch(() => {});
  db.prepare('DELETE FROM owned_knives WHERE id = ?').run(oldest.id);
  db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
  // ...re-render weapon sub-menu
}
```

`shopCategoryKeyboard()`'s weapons button changes from `{ text: '🗡 Оружие (скоро)', callback_data: 'shop:soon' }` to `{ text: '🗡 Оружие', callback_data: 'shop:weapons' }`.

## `/helppvp` text

`/pick`'s existing help line already mentions the knife; no change needed there. The `/shop` help line added by the previous spec currently reads `...оружие и одежда скоро` — update it now that weapons are functional:

```
'/shop — магазин: эликсиры и ржавый нож (купить 5 монет, продать за 3); одежда скоро',
```

## Out of scope

- Clothing shop — separate, later spec.
- No cap on how many knives one player can hold.
- No change to the other 6 weapons' singleton behavior in any way.
