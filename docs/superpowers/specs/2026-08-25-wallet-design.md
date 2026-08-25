# Кошельки (монеты) Design

**Repo:** tg-bot only (`bot.js`). No troll-bot changes.

**Goal:** Give every warrior a coin balance. Grant 20 coins to everyone who's already a warrior (once, on this deploy), make new `/warrior` registrations grant 20 coins going forward, add a `/wallet` command to check your own balance, announce the feature once in the arena chat, and let the existing knockout-loot menu also offer to rob the victim's wallet.

No spending mechanic exists yet — this is purely the balance + the two ways to gain coins (registration, robbery). Out of scope for this spec.

## Schema

One new column on `pvp_stats`, same ALTER-column idiom used throughout this file:

```js
for (const [column, def] of [['coins', 'INTEGER NOT NULL DEFAULT 0']]) {
  try { db.exec(`ALTER TABLE pvp_stats ADD COLUMN ${column} ${def}`); } catch {}
}
```

## `/warrior` grants coins going forward

`/warrior`'s existing registration UPDATE (`is_warrior = 1, xp = xp + 300`) also sets `coins = coins + 20`. One-time, per-user, same as the XP grant — applies to every new registration from this deploy onward.

## One-time retroactive grant + deploy announcement

A new `runOnce` migration (same `migrations_run`-backed helper used for every prior one-off grant this project), giving 20 coins to every warrior who already exists as of this deploy, and announcing the feature once in `ARENA_CHAT_ID`:

```js
runOnce('2026-08-25-warrior-wallets', () => {
  db.exec('UPDATE pvp_stats SET coins = coins + 20 WHERE is_warrior = 1');
  bot.sendMessage(
    ARENA_CHAT_ID,
    '🪙 Всем воинам открыли кошельки — на счету у каждого сразу +20 монет! Баланс — /wallet.'
  ).catch(() => {});
});
```

Runs exactly once, at whichever deploy first includes this code — matching every prior one-off migration's behavior in this file.

## `/wallet` command

Self-only balance check, not part of `/me` (explicit user preference — separate command):

```js
bot.onText(/\/wallet\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const row = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(msg.from.id);
  const coins = row ? row.coins : 0;
  bot.sendMessage(msg.chat.id, `🪙 ${actorLabel}, у тебя в кошельке: ${coins} монет.`, threadOpts(msg)).catch(() => {});
});
```

No `ensureStatsRow` call needed — a `null` row (never touched `pvp_stats`) just reads as 0 coins, matching `/wallet`'s read-only nature; nothing is written here.

## Wallet-robbery button on the existing knockout-loot offer

The existing knockout offer (`performKick`, `targetHealthAfter === 0` block) currently only appears if the victim holds ≥1 weapon. It's restructured to appear if the victim holds ≥1 weapon **or** has ≥1 coin, with a `🪙 Обшарить кошель` button added alongside the per-weapon buttons whenever coins > 0:

```js
const heldWeapons = getWeaponsFor('human', target.id);
const victimCoinsRow = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(target.id);
const victimCoins = victimCoinsRow ? victimCoinsRow.coins : 0;
if (heldWeapons.length > 0 || victimCoins > 0) {
  const defs = heldWeapons.map(row => WEAPON_DEFS[row.weapon_key]);
  const itemParts = defs.map(d => d.accusative);
  if (victimCoins > 0) itemParts.push('кошелёк');
  const itemsText = itemParts.length === 1
    ? itemParts[0]
    : itemParts.slice(0, -1).join(', ') + ' и ' + itemParts[itemParts.length - 1];
  const question = itemParts.length === 1 ? 'Забрать?' : 'Что забрать?';
  const buttons = heldWeapons.map(row => [{
    text: `🗡 Забрать ${WEAPON_DEFS[row.weapon_key].accusative}`,
    callback_data: `steal_yes:${attacker.id}:${target.id}:${row.weapon_key}`,
  }]);
  if (victimCoins > 0) {
    buttons.push([{ text: '🪙 Обшарить кошель', callback_data: `steal_coins:${attacker.id}:${target.id}` }]);
  }
  buttons.push([{ text: '🤝 Оставить', callback_data: `steal_no:${attacker.id}` }]);
  await bot.sendMessage(
    chatId,
    `${targetLabel} в отключке — с ним ${itemsText}. ${question}`,
    threadOpts(msgLike, { reply_markup: { inline_keyboard: buttons } })
  ).catch(() => {});
}
```

Clicking any one button (a weapon, the wallet, or "Оставить") resolves and clears the whole offer — this already falls out of the existing pattern (the callback handler always sets `reply_markup: { inline_keyboard: [] }` on resolution), so "only one action per knockout" needs no extra logic; picking a weapon means the wallet is never rolled and vice versa.

### `steal_coins:` callback handling

New branch in the existing `bot.on('callback_query', ...)` handler, alongside `steal_yes:`/`steal_no:`, following their exact same permission-check → live-reverify → 50/50-grip-roll → resolve pattern:

```js
if (data.startsWith('steal_coins:')) {
  const [, attackerIdStr, victimIdStr] = data.split(':');
  const attackerId = Number(attackerIdStr);
  if (query.from.id !== attackerId) {
    return bot.answerCallbackQuery(query.id, { text: 'Это не твой трофей', show_alert: true }).catch(() => {});
  }

  const victimId = Number(victimIdStr);
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const editOpts = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };

  // Idempotency: coins are fungible (unlike a weapon, whose ownership is
  // a unique resource that naturally can't be "stolen twice"), so a
  // rapid double-click on this same button needs an explicit guard —
  // same class of bug already found and fixed once this session for
  // /give's elixir transfer. Reuses the same resolvedGiveOffers-style
  // Set, keyed the same way (chatId:messageId, capped the same way).
  const resolvedKey = `${chatId}:${messageId}`;
  if (resolvedGiveOffers.has(resolvedKey)) {
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  resolvedGiveOffers.add(resolvedKey);
  if (resolvedGiveOffers.size > MAX_RESOLVED_GIVE_OFFERS) resolvedGiveOffers.delete(resolvedGiveOffers.values().next().value);

  const row = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(victimId);
  const currentCoins = row ? row.coins : 0;
  if (currentCoins <= 0) {
    await bot.editMessageText('Кошелёк уже пуст — кто-то опередил.', editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

  // Same 50/50 grip roll as the weapon-steal branch — the downed victim
  // gets one last chance to hang on to their money too.
  if (Math.random() < 0.5) {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(victimId);
    const victimLabel = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${victimId}`;
    await bot.editMessageText(`🤜 ${actorLabel} пытается обшарить карманы, но ${victimLabel} вцепляется в кошелёк мёртвой хваткой — не отдаёт!`, editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  const amount = Math.floor(Math.random() * currentCoins) + 1;
  db.prepare('UPDATE pvp_stats SET coins = coins - ? WHERE user_id = ?').run(amount, victimId);
  db.prepare('UPDATE pvp_stats SET coins = coins + ? WHERE user_id = ?').run(amount, query.from.id);
  await bot.editMessageText(`🪙 ${actorLabel} обшарил(а) карманы отключившегося и стащил(а) ${amount} монет!`, editOpts).catch(() => {});
  return bot.answerCallbackQuery(query.id).catch(() => {});
}
```

**Note on the idempotency guard:** `resolvedGiveOffers` and `MAX_RESOLVED_GIVE_OFFERS` already exist (added for `/give`'s Stage 2 accept/decline). This reuses that exact same Set rather than introducing a parallel one — the two features' offer messages never collide (different callback-data prefixes, `/give`'s Stage 2 messages are separate Telegram messages from knockout-loot offers), so sharing the dedup Set is safe and avoids a second near-identical piece of state.

`steal_yes:`/`steal_no:` are NOT touched by this spec — weapon ownership is a unique resource, so those two are already naturally idempotent (a second click's live-reverify fails once ownership has moved), unlike coins.

## `/helppvp` text

One new line, placed near `/inventory`/`/restore`/`/recharge` (the other personal-resource commands):

```js
'/wallet — узнать свой баланс монет',
```

## Out of scope

- No spending mechanic (shop, upgrades, anything coins can be used for) — just the balance and the two ways to gain it.
- No troll-bot changes.
- No cap on accumulated coins.
- No change to `steal_yes:`/`steal_no:` beyond the shared button-list restructuring needed to add the wallet option alongside them.
