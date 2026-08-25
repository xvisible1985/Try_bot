# Магазин (каркас) + эликсиры Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/shop` shows a category menu (Эликсиры / Оружие / Одежда). Only Эликсиры is functional — buy a health/energy elixir for 5 coins, sell one back for 3 coins. The other two categories show a "скоро" toast.

**Architecture:** One new command (`/shop`) plus five new `callback_query` branches in the existing single handler, following `/levelup`'s established "self-service, acts on whoever clicked, message stays editable" idiom exactly. No schema changes — `coins`, `health_elixirs`, `energy_elixirs` all already exist on `pvp_stats`.

**Tech Stack:** Node.js, `node-telegram-bot-api`, `better-sqlite3`, single file `bot.js`.

---

## Spec

Full design: `docs/superpowers/specs/2026-08-25-shop-elixirs-design.md`.

## Existing code this plan builds on (verified current line numbers)

- `/restore` — `bot.js:1927-1946` — the guarded elixir-spend `UPDATE ... RETURNING` idiom to mirror for both buy (coins) and sell (elixirs) directions.
- `/recharge` — `bot.js:1948-1964` — `/shop` goes immediately after this.
- `/levelup`'s `levelup:` callback branch — `bot.js:3654` onward — the direct template for "self-service, acts on whoever clicked, editMessageText with a fresh keyboard" that every new `shop:*` branch follows.
- `bot.on('callback_query', ...)` handler — starts `bot.js:3644`. The `steal_yes:`/`steal_no:` guard (`bot.js:3884`, `if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;`) is where every new branch this session has been inserted immediately before — this plan's new `shop:*` branches go there too.
- `/helppvp`'s `/inventory`/`/wallet` lines — `bot.js:3515-3516`.
- `getStats(userId)` does **not** select `coins`/`health_elixirs`/`energy_elixirs` — confirmed by reading its definition (search `function getStats`). Every place in this plan that needs those three columns queries `pvp_stats` directly instead, same workaround `/inventory` already uses.

No schema changes. No troll-bot changes.

---

### Task 1: `/shop` command + category menu

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the `/shop` command and its keyboard helper**

Insert immediately after `/recharge`'s closing `});` (`bot.js:1964`):

```js

// /shop — see docs/superpowers/specs/2026-08-25-shop-elixirs-design.md.
// No warrior gate, matching /restore/recharge/inventory — a non-warrior
// can't buy anything anyway since they can only ever have 0 coins.
function shopCategoryKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧪 Эликсиры', callback_data: 'shop:elixirs' }],
      [{ text: '🗡 Оружие (скоро)', callback_data: 'shop:soon' }],
      [{ text: '👕 Одежда (скоро)', callback_data: 'shop:soon' }],
    ],
  };
}
bot.onText(/\/shop\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  bot.sendMessage(
    msg.chat.id,
    `🏪 ${actorLabel}, магазин:`,
    threadOpts(msg, { reply_markup: shopCategoryKeyboard() })
  ).catch(() => {});
});
```

- [ ] **Step 2: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: add /shop command with category menu"
```

Then push (this repo commits straight to main, no worktree, pushes immediately per standing project convention).

---

### Task 2: `callback_query` branches — elixir buy/sell + category navigation

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the shop helper functions and all `shop:*` branches**

Find (`bot.js:3884`):

```js
  if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;
```

Insert immediately **before** it:

```js
  // /shop — see docs/superpowers/specs/2026-08-25-shop-elixirs-design.md.
  // Self-service, same idiom as levelup: above — acts on whoever
  // clicked (query.from.id), not whoever originally ran /shop, since
  // every user has their own independent pvp_stats row and there's
  // nothing to authorize against. Message stays editable with a fresh
  // keyboard, so repeated purchases don't need re-running the command.
  if (data === 'shop:soon') {
    return bot.answerCallbackQuery(query.id, { text: 'Скоро!', show_alert: true }).catch(() => {});
  }
  if (data === 'shop:back') {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    await bot.editMessageText(`🏪 ${actorLabel}, магазин:`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: shopCategoryKeyboard(),
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  if (data === 'shop:elixirs') {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    ensureStatsRow(query.from.id);
    const stats = db.prepare('SELECT coins, health_elixirs, energy_elixirs FROM pvp_stats WHERE user_id = ?').get(query.from.id);
    await bot.editMessageText(elixirShopText(actorLabel, stats), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: elixirShopKeyboard(),
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  if (data.startsWith('shop:buy:') || data.startsWith('shop:sell:')) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    const userId = query.from.id;
    ensureStatsRow(userId);

    let ok = false;
    if (data === 'shop:buy:health') {
      ok = !!db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
      if (ok) db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?').run(userId);
    } else if (data === 'shop:buy:energy') {
      ok = !!db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
      if (ok) db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs + 1 WHERE user_id = ?').run(userId);
    } else if (data === 'shop:sell:health') {
      ok = !!db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs >= 1 RETURNING health_elixirs').get(userId);
      if (ok) db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
    } else if (data === 'shop:sell:energy') {
      ok = !!db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs - 1 WHERE user_id = ? AND energy_elixirs >= 1 RETURNING energy_elixirs').get(userId);
      if (ok) db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
    }

    if (!ok) {
      const failText = data.startsWith('shop:buy:') ? 'Не хватает монет' : 'Нечего продать';
      return bot.answerCallbackQuery(query.id, { text: failText, show_alert: true }).catch(() => {});
    }

    const stats = db.prepare('SELECT coins, health_elixirs, energy_elixirs FROM pvp_stats WHERE user_id = ?').get(userId);
    await bot.editMessageText(elixirShopText(actorLabel, stats), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: elixirShopKeyboard(),
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

```

- [ ] **Step 2: Add the elixir sub-menu text/keyboard helpers**

Insert right after `shopCategoryKeyboard`'s closing `}` (added in Task 1, search for `function shopCategoryKeyboard`):

```js
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

**Note:** `elixirShopText`/`elixirShopKeyboard` are called from the `callback_query` handler (added in Step 1, which runs later in the file than Task 1's `shopCategoryKeyboard`), but JS function declarations (`function name() {...}`, not `const name = () => {...}`) are hoisted, so definition order relative to call sites doesn't matter here — this mirrors how `shopCategoryKeyboard` itself is already called from inside `/shop`'s handler above its own definition in the file with no issue. Still, place these two new helpers right next to `shopCategoryKeyboard` for readability, not scattered elsewhere.

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Write and run the isolated verification script**

This covers the pure DB-transaction logic for all four buy/sell directions. The Telegram message-editing and the "acts on whoever clicked" behavior aren't independently testable outside a live bot.

Create `c:\Users\123\Projects\tg-bot\_verify_shop.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE pvp_stats (user_id INTEGER PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, health_elixirs INTEGER NOT NULL DEFAULT 0, energy_elixirs INTEGER NOT NULL DEFAULT 0)`);

db.prepare('INSERT INTO pvp_stats (user_id, coins, health_elixirs, energy_elixirs) VALUES (1, 12, 0, 0)').run();
db.prepare('INSERT INTO pvp_stats (user_id, coins, health_elixirs, energy_elixirs) VALUES (2, 3, 0, 0)').run(); // can't afford anything
db.prepare('INSERT INTO pvp_stats (user_id, coins, health_elixirs, energy_elixirs) VALUES (3, 0, 1, 0)').run(); // has one to sell

function buyHealth(userId) {
  const ok = !!db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
  if (ok) db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?').run(userId);
  return ok;
}
function sellHealth(userId) {
  const ok = !!db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs >= 1 RETURNING health_elixirs').get(userId);
  if (ok) db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
  return ok;
}

console.log('user 1 buys health elixir:', buyHealth(1), 'expected true');
console.log('user 1 after buy:', db.prepare('SELECT coins, health_elixirs FROM pvp_stats WHERE user_id=1').get(), 'expected {coins: 7, health_elixirs: 1}');

console.log('user 2 (3 coins) cannot afford:', buyHealth(2), 'expected false');
console.log('user 2 unchanged:', db.prepare('SELECT coins, health_elixirs FROM pvp_stats WHERE user_id=2').get(), 'expected {coins: 3, health_elixirs: 0}');

console.log('user 3 sells their one elixir:', sellHealth(3), 'expected true');
console.log('user 3 after sell:', db.prepare('SELECT coins, health_elixirs FROM pvp_stats WHERE user_id=3').get(), 'expected {coins: 3, health_elixirs: 0}');

console.log('user 3 cannot sell a second (has none left):', sellHealth(3), 'expected false');
console.log('user 3 still:', db.prepare('SELECT coins, health_elixirs FROM pvp_stats WHERE user_id=3').get(), 'expected {coins: 3, health_elixirs: 0}');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_shop.js`

Expected output (must match exactly):
```
user 1 buys health elixir: true expected true
user 1 after buy: { coins: 7, health_elixirs: 1 } expected {coins: 7, health_elixirs: 1}
user 2 (3 coins) cannot afford: false expected false
user 2 unchanged: { coins: 3, health_elixirs: 0 } expected {coins: 3, health_elixirs: 0}
user 3 sells their one elixir: true expected true
user 3 after sell: { coins: 3, health_elixirs: 0 } expected {coins: 3, health_elixirs: 0}
user 3 cannot sell a second (has none left): false expected false
user 3 still: { coins: 3, health_elixirs: 0 } expected {coins: 3, health_elixirs: 0}
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_shop.js`

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: /shop elixir buy/sell + category navigation"
```

Then push.

---

### Task 3: `/helppvp` text

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the `/shop` help line**

Find (`bot.js:3516`):

```js
    '/wallet — узнать свой баланс монет',
```

Add immediately after it:

```js
    '/wallet — узнать свой баланс монет',
    '/shop — магазин: эликсиры за монеты (купить 5 монет, продать за 3); оружие и одежда скоро',
```

- [ ] **Step 2: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "docs: add /shop to /helppvp"
```

Then push.

---

### Task 4: Manual verification (left to user)

- [ ] `/shop` → category menu appears with 3 buttons.
- [ ] Click "Оружие (скоро)" or "Одежда (скоро)" → alert toast "Скоро!", message unchanged.
- [ ] Click "Эликсиры" → sub-menu appears showing correct balance/counts.
- [ ] Buy a health elixir with enough coins → balance drops by 5, `health_elixirs` count rises by 1, message updates in place, confirm via `/inventory`/`/wallet` too.
- [ ] Try to buy with insufficient coins → alert toast "Не хватает монет", nothing changes.
- [ ] Sell a health elixir you own → coins rise by 3, elixir count drops by 1.
- [ ] Try to sell with 0 elixirs → alert toast "Нечего продать", nothing changes.
- [ ] Click "Назад" → returns to the category menu, still editable.
- [ ] Have a DIFFERENT player click buttons on the FIRST player's `/shop` message → confirm it acts on the clicker's own coins/elixirs, not the original caller's (matching `/levelup`'s behavior).

---

## Self-Review

**Spec coverage:** `/shop` + category menu (✅ Task 1), elixir buy/sell + `shop:elixirs`/`shop:back`/`shop:soon` navigation (✅ Task 2), `/helppvp` line (✅ Task 3). Weapon/clothing categories deliberately left as `shop:soon` placeholders, not built out (✅ — matches spec's explicit out-of-scope note).

**Placeholder scan:** No TBD/TODO; every step has complete code or an exact command with expected output. The two `(скоро)` button labels are intentional, spec'd placeholders, not plan placeholders.

**Type consistency:** `callback_data` values are `'shop:elixirs'`, `'shop:back'`, `'shop:soon'`, `'shop:buy:health'`, `'shop:buy:energy'`, `'shop:sell:health'`, `'shop:sell:energy'` — used identically in the keyboard-builder functions (Task 1/2) and the branch-matching code (Task 2), no drift. `elixirShopText`/`elixirShopKeyboard` take no free variables beyond their parameters, called identically from both the `shop:elixirs` branch and every `shop:buy:*`/`shop:sell:*` branch's success path.
