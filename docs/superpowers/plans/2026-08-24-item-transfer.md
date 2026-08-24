# Item Transfer (/give) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one warrior send another warrior a health/energy elixir or a currently-held weapon, with the receiver's explicit accept/decline.

**Architecture:** A new `/give @username` command (target resolution copied from `/kick`) runs 5 pre-checks, then shows the sender an inline keyboard of their current inventory (Stage 1). Picking an item posts a fresh accept/decline message addressed to the receiver (Stage 2), with a 5-minute expiry embedded directly in `callback_data`. All state changes happen atomically inside the existing `bot.on('callback_query', ...)` handler at accept-click time — no new DB table, no escrow, no background timer.

**Tech Stack:** Node.js, `node-telegram-bot-api`, `better-sqlite3`, single file `bot.js`.

---

## Spec

Full design: `docs/superpowers/specs/2026-08-24-item-transfer-design.md`. Read it before starting — this plan implements it directly.

## Existing code this plan builds on (verified current line numbers)

- `WEAPON_DEFS` — `bot.js:1170-1184` (`{name, instrumental, accusative, multiplier, emoji}` per weapon key).
- `threadOpts(msg, extra = {})` — `bot.js:992-996`.
- `ensureStatsRow(userId)` — `bot.js:1248-1250` (lazily inserts a `pvp_stats` row).
- `isWarrior(userId)` — `bot.js:1255-1258`.
- `getWeaponsFor(ownerType, ownerUserId)` — `bot.js:1364-1376` (already filters an expired knife out).
- `/restore` command — `bot.js:1797-1812` — the exact atomic-decrement `UPDATE ... WHERE health_elixirs > 0 RETURNING health_elixirs` idiom to copy for elixir transfer.
- `/recharge` command — `bot.js:1816-1830` — new `/give` command goes immediately after this, starting at line 1831.
- `/kick` target resolution — `bot.js:2159-2182` (`reply_to_message` branch, else `@username` via `bot.getChat`) — copy the resolution branches verbatim into `/give`, do not extract a shared helper (this file's established style is to duplicate these small per-command snippets — see `/restore` and `/recharge` each independently duplicating `actorLabel` construction).
- `bot.on('callback_query', ...)` handler — `bot.js:3284` — currently has two branches: `if (data.startsWith('levelup:'))` and the `steal_yes:`/`steal_no:` block starting at `if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;`. **Read this entire handler (lines 3284-3381) before starting Task 2** — the `steal_yes:`/`steal_no:` block is the direct template for `gv_y:`/`gv_n:`: same `query.from.id !== expectedId` permission-check-with-alert style, same `editOpts = { chat_id, message_id, reply_markup: { inline_keyboard: [] } }` pattern, same "re-verify live state before acting on the snapshot" idiom (see its `expires_at` filter and its 50/50 grip roll for a real example of "don't trust the offer's snapshot, re-check now").
- `pvp_stats` schema — `health_elixirs`/`energy_elixirs` columns added at `bot.js:322` (`INTEGER NOT NULL DEFAULT 0` each).
- `/help` text array — the `/inventory`/`/restore`/`/recharge` lines are at `bot.js:3172-3174`.

No new DB table. No new schema/migration. `db` (the `better-sqlite3` connection) and `bot` (the `node-telegram-bot-api` instance) are both already in module scope and used identically by every command above — no imports needed.

---

### Task 1: `/give` command — target resolution, pre-checks, Stage 1 item picker

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (insert after line 1830, right after the `/recharge` handler's closing `});`)

- [ ] **Step 1: Add the `itemLabel` helper and the `/give` command handler**

Insert this immediately after line 1830 (the blank line following `/recharge`'s closing `});`):

```js
// /give — transfers one elixir or currently-held weapon to another warrior,
// with the receiver's explicit accept/decline (see
// docs/superpowers/specs/2026-08-24-item-transfer-design.md). Two stages,
// both handled in the callback_query listener below: gv_i (sender picks
// which item) posts a fresh message that gv_y/gv_n (receiver accepts or
// declines) resolves. Nothing is reserved ahead of time — the actual
// transfer only happens at gv_y click time, so a stale offer just fails
// gracefully instead of needing rollback.
function itemLabel(itemType) {
  if (itemType === 'elixir:health') return '🧪❤️ эликсир здоровья';
  if (itemType === 'elixir:energy') return '🧪⚡ эликсир энергии';
  const def = WEAPON_DEFS[itemType.slice('weapon:'.length)];
  return `${def.emoji} ${def.accusative}`;
}

// Target resolution copied from /kick (bot.js:2159-2182) rather than
// shared — this file duplicates these small per-command snippets instead
// of extracting a helper.
bot.onText(/\/give(?:@\w+)?(?:\s+@?(\S+))?/, async (msg, match) => {
  let target = null;
  if (msg.reply_to_message && msg.reply_to_message.from) {
    target = {
      id: msg.reply_to_message.from.id,
      username: msg.reply_to_message.from.username,
      firstName: msg.reply_to_message.from.first_name,
    };
  } else if (match[1]) {
    const handle = match[1].replace(/^@/, '');
    try {
      const chat = await bot.getChat('@' + handle);
      target = { id: chat.id, username: chat.username, firstName: chat.first_name };
    } catch {}
  }

  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  if (!target) {
    bot.sendMessage(msg.chat.id, 'Укажи @юзернейм или ответь на сообщение того, кому хочешь передать предмет.', threadOpts(msg)).catch(() => {});
    return;
  }
  const targetLabel = target.username ? `@${target.username}` : target.firstName;

  if (target.id === msg.from.id) {
    bot.sendMessage(msg.chat.id, 'Себе что ли? 🤔', threadOpts(msg)).catch(() => {});
    return;
  }
  if (!isWarrior(msg.from.id)) {
    bot.sendMessage(msg.chat.id, 'Сначала стань воином: /warrior', threadOpts(msg)).catch(() => {});
    return;
  }
  if (!isWarrior(target.id)) {
    bot.sendMessage(msg.chat.id, `${targetLabel} ещё не воин — нечего ему передавать.`, threadOpts(msg)).catch(() => {});
    return;
  }

  ensureStatsRow(msg.from.id);
  const stats = db.prepare('SELECT health_elixirs, energy_elixirs FROM pvp_stats WHERE user_id = ?').get(msg.from.id);
  const weapons = getWeaponsFor('human', msg.from.id);

  if (stats.health_elixirs <= 0 && stats.energy_elixirs <= 0 && weapons.length === 0) {
    bot.sendMessage(msg.chat.id, 'Нечего передать — глянь /inventory.', threadOpts(msg)).catch(() => {});
    return;
  }

  const buttons = [];
  if (stats.health_elixirs > 0) {
    buttons.push([{ text: `🧪❤️ Эликсир здоровья ×${stats.health_elixirs}`, callback_data: `gv_i:${msg.from.id}:${target.id}:elixir:health` }]);
  }
  if (stats.energy_elixirs > 0) {
    buttons.push([{ text: `🧪⚡ Эликсир энергии ×${stats.energy_elixirs}`, callback_data: `gv_i:${msg.from.id}:${target.id}:elixir:energy` }]);
  }
  for (const { weapon_key } of weapons) {
    const def = WEAPON_DEFS[weapon_key];
    buttons.push([{ text: `${def.emoji} ${def.name}`, callback_data: `gv_i:${msg.from.id}:${target.id}:weapon:${weapon_key}` }]);
  }

  bot.sendMessage(
    msg.chat.id,
    `${actorLabel}, что передать ${targetLabel}?`,
    threadOpts(msg, { reply_markup: { inline_keyboard: buttons } })
  ).catch(() => {});
});
```

- [ ] **Step 2: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: add /give command with Stage 1 item picker"
```

---

### Task 2: `callback_query` additions — `gv_i:`, `gv_y:`, `gv_n:` branches

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (inside the existing `bot.on('callback_query', ...)` handler, currently starting at line 3284 — re-locate by searching for `bot.on('callback_query'` since Task 1 shifted line numbers by ~75 lines)

Before writing code, read the full existing handler (the `levelup:` branch and the `steal_yes:`/`steal_no:` block) — this task adds new `if (data.startsWith(...))` branches in the same style, inserted between them.

- [ ] **Step 1: Add the `gv_i:` branch (Stage 1 → Stage 2)**

Locate this line inside the handler:

```js
  if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;
```

Insert the new branch immediately **before** it (so it sits between the existing `levelup:` block and the existing `steal_yes:`/`steal_no:` block):

```js
  // /give Stage 1 -> Stage 2: sender picked an item. Re-verify it's still
  // available (they may have spent/given it away while the keyboard sat
  // unclicked), then post a fresh message addressed to the receiver with
  // a 5-minute expiry embedded in callback_data (same lazy-expiry idiom
  // as hidden_until/mutes/the knife's own expires_at — no timer needed).
  if (data.startsWith('gv_i:')) {
    const [, senderIdStr, targetIdStr, ...itemParts] = data.split(':');
    const senderId = Number(senderIdStr);
    const targetId = Number(targetIdStr);
    const itemType = itemParts.join(':');

    if (query.from.id !== senderId) {
      return bot.answerCallbackQuery(query.id, { text: 'Это не твоё предложение', show_alert: true }).catch(() => {});
    }

    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const editOpts = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

    let available = false;
    if (itemType === 'elixir:health') {
      const row = db.prepare('SELECT health_elixirs FROM pvp_stats WHERE user_id = ?').get(senderId);
      available = !!row && row.health_elixirs > 0;
    } else if (itemType === 'elixir:energy') {
      const row = db.prepare('SELECT energy_elixirs FROM pvp_stats WHERE user_id = ?').get(senderId);
      available = !!row && row.energy_elixirs > 0;
    } else {
      const weaponKey = itemType.slice('weapon:'.length);
      const row = db.prepare(
        "SELECT 1 FROM weapon_ownership WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
        "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
      ).get(weaponKey, senderId);
      available = !!row;
    }
    if (!available) {
      await bot.editMessageText('Этого у тебя уже нет.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    await bot.editMessageText(`${actorLabel} предлагает ${itemLabel(itemType)}. Ожидание ответа...`, editOpts).catch(() => {});

    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(targetId);
    const targetLabel = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${targetId}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 300;

    bot.sendMessage(
      chatId,
      `🎁 ${actorLabel} хочет передать тебе ${itemLabel(itemType)}, ${targetLabel}. Принимаешь?`,
      threadOpts(query.message, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Принять', callback_data: `gv_y:${senderId}:${targetId}:${itemType}:${expiresAt}` },
            { text: 'Отклонить', callback_data: `gv_n:${senderId}:${targetId}:${itemType}:${expiresAt}` },
          ]],
        },
      })
    ).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  // /give Stage 2: receiver accepts or declines. Nothing was reserved at
  // Stage 1, so gv_y re-verifies and transfers atomically right here;
  // gv_n just leaves everything as-is.
  if (data.startsWith('gv_y:') || data.startsWith('gv_n:')) {
    const [action, senderIdStr, targetIdStr, ...rest] = data.split(':');
    const senderId = Number(senderIdStr);
    const targetId = Number(targetIdStr);
    const expiresAt = Number(rest[rest.length - 1]);
    const itemType = rest.slice(0, -1).join(':');

    if (query.from.id !== targetId) {
      return bot.answerCallbackQuery(query.id, { text: 'Это предложение не тебе', show_alert: true }).catch(() => {});
    }

    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const editOpts = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };
    const senderKnown = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(senderId);
    const senderLabel = senderKnown ? (senderKnown.username ? `@${senderKnown.username}` : senderKnown.first_name) : `игрок ${senderId}`;
    const targetLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

    if (action === 'gv_n') {
      await bot.editMessageText(`Отклонено — предмет остался у ${senderLabel}.`, editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > expiresAt) {
      await bot.editMessageText('Предложение просрочено.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    let transferred = false;
    if (itemType === 'elixir:health') {
      const spent = db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs > 0 RETURNING health_elixirs').get(senderId);
      if (spent) {
        ensureStatsRow(targetId);
        db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?').run(targetId);
        transferred = true;
      }
    } else if (itemType === 'elixir:energy') {
      const spent = db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs - 1 WHERE user_id = ? AND energy_elixirs > 0 RETURNING energy_elixirs').get(senderId);
      if (spent) {
        ensureStatsRow(targetId);
        db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs + 1 WHERE user_id = ?').run(targetId);
        transferred = true;
      }
    } else {
      const weaponKey = itemType.slice('weapon:'.length);
      const result = db.prepare(
        "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? " +
        "WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
        "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
      ).run(targetId, query.from.username, weaponKey, senderId);
      transferred = result.changes > 0;
    }

    if (!transferred) {
      await bot.editMessageText('У отправителя этого уже нет.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    await bot.editMessageText(`✅ ${senderLabel} передал(а) ${itemLabel(itemType)} игроку ${targetLabel}!`, editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

```

- [ ] **Step 2: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Write and run the isolated verification script**

This is the one place with real, isolable DB-transaction logic (the Telegram message-sending itself isn't independently testable outside a live bot). Create `c:\Users\123\Projects\tg-bot\_verify_give.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE pvp_stats (user_id INTEGER PRIMARY KEY, health_elixirs INTEGER NOT NULL DEFAULT 0, energy_elixirs INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT, expires_at INTEGER)`);

db.prepare('INSERT INTO pvp_stats (user_id, health_elixirs, energy_elixirs) VALUES (1, 2, 0)').run();
db.prepare('INSERT INTO pvp_stats (user_id, health_elixirs, energy_elixirs) VALUES (2, 0, 0)').run();
db.prepare("INSERT INTO weapon_ownership (weapon_key, owner_type, owner_user_id, expires_at) VALUES ('knife', 'human', 1, NULL)").run();
db.prepare("INSERT INTO weapon_ownership (weapon_key, owner_type, owner_user_id, expires_at) VALUES ('bat', 'human', 1, strftime('%s','now') - 10)").run(); // already expired

// 1. Elixir transfer succeeds when count > 0
let spent = db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs > 0 RETURNING health_elixirs').get(1);
console.log('elixir transfer 1 (2->1):', spent, 'expected {health_elixirs: 1}');
if (spent) db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?').run(2);
console.log('receiver after credit:', db.prepare('SELECT health_elixirs FROM pvp_stats WHERE user_id = 2').get(), 'expected {health_elixirs: 1}');

// 2. Elixir transfer fails when sender already spent it (race: count now hits 0 after one more genuine spend)
db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs > 0').run(1); // sender's last one spent elsewhere (e.g. /restore)
spent = db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs > 0 RETURNING health_elixirs').get(1);
console.log('elixir transfer on empty:', spent, 'expected undefined');

// 3. Weapon transfer succeeds when sender still owns it and it's not expired
let result = db.prepare(
  "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
).run(2, 'receiver', 'knife', 1);
console.log('weapon transfer (owned, not expired):', result.changes, 'expected 1');
console.log('knife new owner:', db.prepare("SELECT owner_user_id FROM weapon_ownership WHERE weapon_key='knife'").get(), 'expected {owner_user_id: 2}');

// 4. Weapon transfer fails when sender no longer owns it (already moved)
result = db.prepare(
  "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
).run(2, 'receiver', 'knife', 1); // sender (1) no longer owns it, owner is now 2
console.log('weapon transfer (no longer owned):', result.changes, 'expected 0');

// 5. Weapon transfer fails when expired
result = db.prepare(
  "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
).run(2, 'receiver', 'bat', 1);
console.log('weapon transfer (expired):', result.changes, 'expected 0');

// 6. expiresAt lazy comparison
const expiresAt = Math.floor(Date.now() / 1000) + 300;
const nowBeforeExpiry = Math.floor(Date.now() / 1000);
const nowAfterExpiry = expiresAt + 1;
console.log('accept before expiry allowed:', nowBeforeExpiry <= expiresAt, 'expected true');
console.log('accept after expiry blocked:', nowAfterExpiry > expiresAt, 'expected true');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_give.js`

Expected output (values must match exactly):
```
elixir transfer 1 (2->1): { health_elixirs: 1 } expected {health_elixirs: 1}
receiver after credit: { health_elixirs: 1 } expected {health_elixirs: 1}
elixir transfer on empty: undefined expected undefined
weapon transfer (owned, not expired): 1 expected 1
knife new owner: { owner_user_id: 2 } expected {owner_user_id: 2}
weapon transfer (no longer owned): 0 expected 0
weapon transfer (expired): 0 expected 0
accept before expiry allowed: true expected true
accept after expiry blocked: true expected true
```

Delete the scratch script after confirming the output matches:

```bash
rm c:\Users\123\Projects\tg-bot\_verify_give.js
```

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add /give Stage 1/2 callback_query handling (atomic transfer)"
```

---

### Task 3: `/help` text

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (the `/help` text array, currently at `bot.js:3172-3174` before Task 1/2 shift the line numbers — re-locate by searching for `'/recharge — выпить эликсир энергии'`)

- [ ] **Step 1: Add a `/give` line to the `/help` array**

Find:

```js
    '/recharge — выпить эликсир энергии: полное восстановление',
```

Add immediately after it:

```js
    '/recharge — выпить эликсир энергии: полное восстановление',
    '/give @username — передать эликсир или оружие другому воину (с его подтверждением)',
```

- [ ] **Step 2: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "docs: add /give to /help text"
```

---

### Task 4: Manual verification (left to user)

Not automated — deployment is the user's own GitHub-based flow. After all tasks are pushed and the user restarts the bot (`pm2 restart tg-bot`), verify manually:

- [ ] `/give` with no target and no reply → "Укажи @юзернейм..." message.
- [ ] `/give @self` → "Себе что ли? 🤔"
- [ ] `/give @nonWarrior` from a warrior with items → "ещё не воин" message.
- [ ] `/give @warriorWithNothingToGive` run by a warrior holding 0 elixirs and 0 weapons → "Нечего передать" message, before any target/warrior checks would even matter (i.e. sender-side check).
- [ ] Full happy path: warrior A (holding a knife and 1 health elixir) runs `/give @B` (B a warrior) → Stage 1 keyboard shows both items → A clicks the elixir button → Stage 2 message posted addressed to B → B clicks "Принять" → success message, `/inventory` for both A and B reflects the new counts.
- [ ] Weapon happy path: same as above but A picks the knife → B accepts → `/me` for both A and B shows the knife moved, and the knife's remaining decay time (`expires_at`) is unchanged from before the transfer (not reset to a fresh 3 hours).
- [ ] Decline path: A sends an offer, B clicks "Отклонить" → item stays with A (confirm via `/inventory`/`/me`), no state changed.
- [ ] Race/expiry path: A sends an offer, then A spends the same elixir via `/restore` before B clicks "Принять" → B's accept click shows "У отправителя этого уже нет.", nothing is deducted from B or re-added to A.
- [ ] Wrong-clicker path: A sends an offer to B; have a third user C click B's "Принять" button (if testable) → C gets the "Это предложение не тебе" alert, nothing changes.

---

## Self-Review

**Spec coverage:** Command syntax + reply-to (✅ Task 1), all 5 pre-checks in the spec's exact order (✅ Task 1), Stage 1 keyboard with per-item buttons and `gv_i:` callback_data format (✅ Task 1/2), Stage 1 permission check + live re-verify + edit-to-waiting + Stage 2 send with embedded `expiresAt` (✅ Task 2 Step 1), Stage 2 permission check + expiry check + atomic elixir/weapon transfer with the knife `expires_at` guard + final messages (✅ Task 2 Step 1), item label text mapping (✅ `itemLabel` in Task 1, reused in Task 2), `/help` line (✅ Task 3), no new DB table (✅ — confirmed no `CREATE TABLE` anywhere in this plan), no troll-bot changes (✅ — plan touches only tg-bot's `bot.js`).

**Placeholder scan:** No TBD/TODO; every step has complete code or an exact command with expected output.

**Type consistency:** `itemType` is always one of `'elixir:health'`, `'elixir:energy'`, or `'weapon:<key>'` end to end — built that way in Task 1's button `callback_data`, parsed that way in Task 2's `gv_i:`/`gv_y:`/`gv_n:` branches (note the `itemParts.join(':')` / `rest.slice(0, -1).join(':')` reconstruction, needed because `weapon:<key>` itself contains a colon and `data.split(':')` would otherwise fragment it — verified against `WEAPON_DEFS` keys, none of which contain a colon). `itemLabel()` is defined once in Task 1 and called from both Task 1 (not directly, only via the button text which is built manually) and Task 2 (both branches) — consistent signature `itemLabel(itemType: string): string` throughout.
