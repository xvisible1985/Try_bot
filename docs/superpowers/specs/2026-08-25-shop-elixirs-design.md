# Магазин (каркас) + эликсиры Design

**Repo:** tg-bot only (`bot.js`). No troll-bot changes.

**Goal:** A `/shop` command showing a category menu (Эликсиры / Оружие / Одежда). Only "Эликсиры" is functional in this piece — buy a health or energy elixir for 5 coins each, or sell one back for 3 coins each. The other two categories show a "скоро" placeholder until their own specs ship.

## Command

`bot.onText(/\/shop\b/i, ...)` — no warrior gate (matches `/restore`/`/recharge`/`/inventory`, none of which require `is_warrior`; a non-warrior naturally can't buy anything anyway since they can only ever have 0 coins).

```js
bot.onText(/\/shop\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  bot.sendMessage(
    msg.chat.id,
    `🏪 ${actorLabel}, магазин:`,
    threadOpts(msg, { reply_markup: shopCategoryKeyboard() })
  ).catch(() => {});
});

function shopCategoryKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧪 Эликсиры', callback_data: 'shop:elixirs' }],
      [{ text: '🗡 Оружие (скоро)', callback_data: 'shop:soon' }],
      [{ text: '👕 Одежда (скоро)', callback_data: 'shop:soon' }],
    ],
  };
}
```

## Interaction model — self-service, same as `/levelup`

Every button acts on **whoever clicked it** (`query.from.id`), not whoever originally ran `/shop` — same idiom `/levelup`'s buttons already use ("acts on whoever clicked... every user has their own independent pvp_stats row, so there's nothing to authorize against"). If player A runs `/shop` and player B clicks a button on A's message, B buys/sells using B's own coins/elixirs, and the message updates to address B. No permission check needed.

The message stays editable with a fresh keyboard after every click (again matching `/levelup`), so repeated purchases don't require re-running `/shop`.

## `callback_query` branches

New branches in the existing single `bot.on('callback_query', ...)` handler:

- `shop:elixirs` — edits the message to the elixir sub-menu (buy/sell buttons + a back button), showing the clicker's current coin balance and elixir counts.
- `shop:soon` — `answerCallbackQuery` with an alert, e.g. "Скоро!" — no message edit.
- `shop:back` — edits back to the top-level category menu.
- `shop:buy:health` / `shop:buy:energy` — guarded coin debit (5) + elixir credit (1), re-render the elixir sub-menu with updated numbers.
- `shop:sell:health` / `shop:sell:energy` — guarded elixir debit (1) + coin credit (3), re-render the elixir sub-menu with updated numbers.

```js
// stats here is a direct `SELECT coins, health_elixirs, energy_elixirs
// FROM pvp_stats WHERE user_id = ?` — NOT the existing getStats() helper,
// whose SELECT list doesn't include these three columns (same gap
// /inventory already had to work around by querying pvp_stats directly).
function elixirShopText(actorLabel, stats) {
  return `🧪 ${actorLabel}, магазин эликсиров. Баланс: ${stats.coins} монет. У тебя: ❤️×${stats.health_elixirs}, ⚡×${stats.energy_elixirs}.\n` +
    `Купить эликсир здоровья — 5 монет | Купить эликсир энергии — 5 монет\n` +
    `Продать эликсир здоровья — 3 монеты | Продать эликсир энергии — 3 монеты`;
}
function elixirShopKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧪❤️ Купить (5)', callback_data: 'shop:buy:health' }, { text: '🧪⚡ Купить (5)', callback_data: 'shop:buy:energy' }],
      [{ text: '🧪❤️ Продать (3)', callback_data: 'shop:sell:health' }, { text: '🧪⚡ Продать (3)', callback_data: 'shop:sell:energy' }],
      [{ text: '⬅️ Назад', callback_data: 'shop:back' }],
    ],
  };
}
```

Each `shop:buy:*`/`shop:sell:*` branch does a guarded atomic UPDATE (mirroring `/restore`'s own `WHERE health_elixirs > 0 RETURNING ...` idiom and the wallet's own `WHERE coins >= 1 RETURNING ...` idiom):

```js
// buy health elixir example — buy energy / sell health / sell energy follow the identical shape with swapped column/amount
const spent = db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
if (!spent) {
  return bot.answerCallbackQuery(query.id, { text: 'Не хватает монет', show_alert: true }).catch(() => {});
}
db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?').run(userId);
```

On success, re-fetch the clicker's fresh `pvp_stats` row and re-render `elixirShopText`/`elixirShopKeyboard` via `editMessageText` (keeping the same message, same keyboard shape) — no separate confirmation message, the updated numbers in the edited text ARE the confirmation. On failure (insufficient coins/elixirs), `answerCallbackQuery` with a `show_alert` toast, no message edit — matches `/levelup`'s "not enough points" handling style (an edit there, but the toast style here is more appropriate since nothing changed to redraw).

## `/helppvp` text

```js
'/shop — магазин: эликсиры за монеты (купить 5 монет, продать за 3); оружие и одежда скоро',
```

## Out of scope

- Weapon and clothing categories — separate, later specs. `shop:soon` is a deliberate, temporary placeholder, not a stub to build out here.
- No purchase limits, no cooldown — repeatable at will, bounded only by available coins/elixirs.
- No troll-bot changes.
