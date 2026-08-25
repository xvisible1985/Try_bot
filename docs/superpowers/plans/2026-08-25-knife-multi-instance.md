# Нож как множественный предмет + магазин оружия Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple knives can exist simultaneously, each independently owned and independently decaying 3h after its own acquisition. `/shop`'s weapon category buys/sells knives for 5/3 coins.

**Architecture:** Knife moves out of the singleton `weapon_ownership` table into a new `owned_knives` table (one row per physical knife). Every place that identifies "a specific weapon" gains an `instanceKey` string alongside the existing `weapon_key` — `weapon_key` itself for the 6 singleton weapons (unchanged behavior), `"knife:" + id` for a knife. `getWeaponsFor` is the one place that produces this pairing; every consumer (steal offer, `/give`, fumble drop/pickup, `/kick` slot picking, `/me` display, the new shop) branches on whether an `instanceKey` starts with `"knife:"`.

**Tech Stack:** Node.js, `node-telegram-bot-api`, `better-sqlite3`, single file `bot.js`.

---

## Spec

Full design: `docs/superpowers/specs/2026-08-25-knife-multi-instance-design.md`. Read it before starting — this plan implements it directly.

## Critical shared context — read this before any task

**This is the largest, highest-risk plan of this session's economy features.** It touches 8+ existing, already-shipped, working features. Every task below gives exact Find/Replace blocks against the CURRENT file content — but this file changes with every task in this plan, so **re-locate every anchor by searching for the quoted surrounding text, never trust a stated line number.**

**The colon-splitting trap (same class of bug this session already hit once with `/give`'s `itemType`):** `callback_data` strings are colon-delimited (`steal_yes:100:200:knife:17`). A naive `data.split(':')` positional destructure would fragment a knife's `instanceKey` (`"knife:17"`, which itself contains a colon) incorrectly. Every task below that touches `callback_data` parsing either (a) already uses a colon-safe `...rest` array + `.join(':')` reconstruction (verify this explicitly before editing, don't assume), or (b) is shown with that fix included. **Do not "simplify" any positional destructure you see — if it looks like it should be a fixed number of parts, double-check against this trap first.**

**Existing code this plan builds on (verified current, but re-locate by search since earlier tasks in this same plan will shift these):**
- `weapon_ownership` table + knife's seed row — search `CREATE TABLE IF NOT EXISTS weapon_ownership` and `VALUES ('knife', NULL, 'none'`.
- `getWeaponsFor` / `pickWeaponForAttacker` — search `function getWeaponsFor`.
- `performKick`'s fumble-drop (`roll === 0 && weapon.key`) — search that exact text.
- The fumble-pickup listener in the main message handler — search `droppedHere`.
- The knockout-loot steal offer button-building — search `steal_yes:\${attacker.id}`.
- The `steal_yes:`/`steal_no:` callback branch — search `data.startsWith('steal_yes:') && !data.startsWith('steal_no:')`.
- `/give`'s weapon button-building — search `gv_i:\${msg.from.id}:\${target.id}:weapon:`.
- `itemLabel(itemType)` — search `function itemLabel`.
- The `gv_i:`/`gv_y:` callback branches — search `data.startsWith('gv_i:')` and `data.startsWith('gv_y:')`.
- `/pick`'s knife branch — search `WHERE weapon_key = 'knife'` inside `bot.onText(/\/pick\b/i`.
- `arenaTick` — search `function arenaTick`.
- `/me`'s weapon display loop — search `heldWeapons.forEach`.
- `shopCategoryKeyboard`, `elixirShopText`, `elixirShopKeyboard` — search `function shopCategoryKeyboard` (all three sit together).
- The combined `shop:buy:`/`shop:sell:` callback branch — search `data.startsWith('shop:buy:') || data.startsWith('shop:sell:')`.
- `formatExpire(expiresAt)` — an existing helper (search `function formatExpire`) that turns a unix-seconds timestamp into a human string like `"2ч 15м"` — reused for the knife's remaining-time display in `/me`.

No troll-bot changes anywhere in this plan.

---

### Task 1: Schema — `owned_knives` table + retirement migration

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the `owned_knives` table**

Insert immediately after the `weapon_ownership` table's closing `` `); `` (search for `CREATE TABLE IF NOT EXISTS weapon_ownership`, insert right after its own closing backtick-paren-semicolon, before the fumble-drop comment block that currently follows):

```js

// Knife instances — see
// docs/superpowers/specs/2026-08-25-knife-multi-instance-design.md.
// Unlike every weapon in weapon_ownership (weapon_key is a PK, so at
// most one of each can ever exist), a player can hold several knives
// at once, each independently decaying 3h after its own acquisition —
// one row per physical knife. is_dropped/dropped_chat_id mirror
// weapon_ownership's own fumble-drop convention exactly (owner_user_id
// repurposed to "who dropped it" while is_dropped=1, so they can't
// immediately re-pick their own).
db.exec(`
  CREATE TABLE IF NOT EXISTS owned_knives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    owner_username TEXT,
    is_dropped INTEGER NOT NULL DEFAULT 0,
    dropped_chat_id INTEGER,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);
```

- [ ] **Step 2: Retirement migration**

Insert right after `owned_knives`'s `CREATE TABLE` statement from Step 1 (i.e., directly below what you just added):

```js
// One-time: carry over a currently-actively-held knife (if any) into
// its own owned_knives row, then retire weapon_ownership's singleton
// knife row entirely — going forward, /pick, the shop, and every other
// knife-touching site use owned_knives exclusively. A fumble-dropped-
// but-unclaimed knife at migration time is intentionally NOT carried
// over (an edge case not worth the extra complexity) — it simply
// ceases to exist, same as if it had fully decayed.
runOnce('2026-08-25-knife-multi-instance-migration', () => {
  const existing = db.prepare("SELECT owner_user_id, owner_username, expires_at FROM weapon_ownership WHERE weapon_key = 'knife' AND owner_type = 'human'").get();
  if (existing) {
    db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)')
      .run(existing.owner_user_id, existing.owner_username, Math.floor(Date.now() / 1000), existing.expires_at);
  }
  db.exec("DELETE FROM weapon_ownership WHERE weapon_key = 'knife'");
});
```

**Do NOT** touch the `('knife', NULL, 'none', ...)` seed-row `INSERT OR IGNORE` line further down in the file yet — leave it exactly as-is for this task (a later task in this plan removes it once nothing reads `weapon_ownership` for knife anymore; removing it now, before `getWeaponsFor` stops querying it for knife, would be premature).

**Ordering note:** `runOnce` is already defined earlier in the file by this point (verify: search `function runOnce`, confirm its definition line is numerically before wherever you're inserting this) — this migration doesn't reference anything declared later in the file (no `ARENA_CHAT_ID`-style ordering hazard like больничка's wallet migration had), so there's no special placement constraint beyond "after `runOnce` and `owned_knives` both exist."

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_knife1.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT, expires_at INTEGER)`);
db.exec(`CREATE TABLE owned_knives (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, owner_username TEXT, is_dropped INTEGER NOT NULL DEFAULT 0, dropped_chat_id INTEGER, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
db.exec(`CREATE TABLE migrations_run (name TEXT PRIMARY KEY, run_at INTEGER)`);
function runOnce(name, fn) {
  if (db.prepare('SELECT 1 FROM migrations_run WHERE name = ?').get(name)) return;
  fn();
  db.prepare('INSERT INTO migrations_run (name, run_at) VALUES (?, ?)').run(name, 0);
}

function migrate() {
  runOnce('2026-08-25-knife-multi-instance-migration', () => {
    const existing = db.prepare("SELECT owner_user_id, owner_username, expires_at FROM weapon_ownership WHERE weapon_key = 'knife' AND owner_type = 'human'").get();
    if (existing) {
      db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)')
        .run(existing.owner_user_id, existing.owner_username, Math.floor(Date.now() / 1000), existing.expires_at);
    }
    db.exec("DELETE FROM weapon_ownership WHERE weapon_key = 'knife'");
  });
}

// Scenario: a knife is actively held at migration time
db.prepare("INSERT INTO weapon_ownership (weapon_key, owner_type, owner_user_id, owner_username, expires_at) VALUES ('knife', 'human', 42, 'someuser', 99999)").run();
migrate();
console.log('weapon_ownership knife row gone:', db.prepare("SELECT 1 FROM weapon_ownership WHERE weapon_key='knife'").get(), 'expected undefined');
console.log('owned_knives has the carried-over row:', db.prepare('SELECT owner_user_id, owner_username, expires_at FROM owned_knives').get(), 'expected {owner_user_id: 42, owner_username: "someuser", expires_at: 99999}');

// Re-running must not duplicate or re-fire
migrate();
console.log('still exactly one owned_knives row after second boot:', db.prepare('SELECT COUNT(*) AS n FROM owned_knives').get(), 'expected {n: 1}');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_knife1.js`

Expected output (must match exactly):
```
weapon_ownership knife row gone: undefined expected undefined
owned_knives has the carried-over row: { owner_user_id: 42, owner_username: 'someuser', expires_at: 99999 } expected {owner_user_id: 42, owner_username: "someuser", expires_at: 99999}
still exactly one owned_knives row after second boot: { n: 1 } expected {n: 1}
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_knife1.js`

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: add owned_knives table + retire weapon_ownership's singleton knife row"
```

Then push (this repo commits straight to main, no worktree, pushes immediately per standing project convention).

---

### Task 2: `getWeaponsFor` + `pickWeaponForAttacker` — the `instanceKey` abstraction

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Rewrite `getWeaponsFor`**

Find (search `function getWeaponsFor`):

```js
function getWeaponsFor(ownerType, ownerUserId) {
  // expires_at only ever matters for the knife (every other weapon's is
  // always NULL) — filtering it out here, in the one shared read
  // function, means an expired-but-not-yet-swept knife silently stops
  // counting everywhere (/kickN slots, /me, /find, /warriors) without
  // needing arenaTick's own cleanup to have run first.
  return ownerType === 'troll'
    ? db.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'troll' ORDER BY rowid").all()
    : db.prepare(
        "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
        "AND (expires_at IS NULL OR expires_at > strftime('%s','now')) ORDER BY rowid"
      ).all(ownerUserId);
}
```

Replace with:

```js
function getWeaponsFor(ownerType, ownerUserId) {
  // Returns { weapon_key, instanceKey } rows. instanceKey === weapon_key
  // for every singleton weapon (bat/axe/scissors/crutch/horns/carrot —
  // weapon_key is still a PK for these, unchanged behavior) — it only
  // ever differs for a knife, where it's "knife:<owned_knives.id>" so a
  // SPECIFIC physical knife can be identified among several this same
  // owner might hold. Regular weapons first (stable rowid order, as
  // before), knives appended after in acquisition order.
  if (ownerType === 'troll') {
    return db.prepare("SELECT weapon_key, weapon_key AS instanceKey FROM weapon_ownership WHERE owner_type = 'troll' ORDER BY rowid").all();
  }
  const regular = db.prepare(
    "SELECT weapon_key, weapon_key AS instanceKey FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now')) ORDER BY rowid"
  ).all(ownerUserId);
  const knives = db.prepare(
    "SELECT id, expires_at FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now') ORDER BY id"
  ).all(ownerUserId).map(row => ({ weapon_key: 'knife', instanceKey: `knife:${row.id}`, expiresAt: row.expires_at }));
  return [...regular, ...knives];
}
```

- [ ] **Step 2: Thread `instanceKey` through `pickWeaponForAttacker`**

Find (search `function pickWeaponForAttacker`):

```js
function pickWeaponForAttacker(ownerType, ownerUserId, slot, fallbackWeapons) {
  if (slot > 0) {
    const owned = getWeaponsFor(ownerType, ownerUserId);
    const row = owned[slot - 1];
    if (row) {
      const def = WEAPON_DEFS[row.weapon_key];
      return { key: row.weapon_key, text: def.instrumental, multiplier: def.multiplier };
    }
  }
  return { key: null, text: pick(fallbackWeapons), multiplier: 1 };
}
```

Replace with:

```js
function pickWeaponForAttacker(ownerType, ownerUserId, slot, fallbackWeapons) {
  if (slot > 0) {
    const owned = getWeaponsFor(ownerType, ownerUserId);
    const row = owned[slot - 1];
    if (row) {
      const def = WEAPON_DEFS[row.weapon_key];
      return { key: row.weapon_key, instanceKey: row.instanceKey, text: def.instrumental, multiplier: def.multiplier };
    }
  }
  return { key: null, instanceKey: null, text: pick(fallbackWeapons), multiplier: 1 };
}
```

(`weapon.instanceKey` is consumed by `performKick`'s fumble-drop logic — see Task 3.)

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_knife2.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT, expires_at INTEGER)`);
db.exec(`CREATE TABLE owned_knives (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, owner_username TEXT, is_dropped INTEGER NOT NULL DEFAULT 0, dropped_chat_id INTEGER, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);

function getWeaponsFor(ownerType, ownerUserId) {
  if (ownerType === 'troll') {
    return db.prepare("SELECT weapon_key, weapon_key AS instanceKey FROM weapon_ownership WHERE owner_type = 'troll' ORDER BY rowid").all();
  }
  const regular = db.prepare(
    "SELECT weapon_key, weapon_key AS instanceKey FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now')) ORDER BY rowid"
  ).all(ownerUserId);
  const knives = db.prepare(
    "SELECT id, expires_at FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now') ORDER BY id"
  ).all(ownerUserId).map(row => ({ weapon_key: 'knife', instanceKey: `knife:${row.id}`, expiresAt: row.expires_at }));
  return [...regular, ...knives];
}

const now = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO weapon_ownership (weapon_key, owner_type, owner_user_id) VALUES ('bat', 'human', 1)").run();
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (1, 0, ?, ?)').run(now, now + 3600);
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (1, 0, ?, ?)').run(now, now + 7200);
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (1, 1, ?, ?)').run(now, now + 3600); // dropped, must NOT appear
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (1, 0, ?, ?)').run(now, now - 10); // expired, must NOT appear

const owned = getWeaponsFor('human', 1);
console.log('count (1 bat + 2 live knives, not the dropped/expired ones):', owned.length, 'expected 3');
console.log('first row is the bat, instanceKey === weapon_key:', owned[0], 'expected {weapon_key: "bat", instanceKey: "bat"}');
console.log('second row is a knife with a distinct instanceKey:', owned[1].weapon_key, owned[1].instanceKey, 'expected knife knife:1');
console.log('third row is the OTHER knife, different instanceKey:', owned[2].weapon_key, owned[2].instanceKey, 'expected knife knife:2');
console.log('instanceKeys are distinct:', owned[1].instanceKey !== owned[2].instanceKey, 'expected true');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_knife2.js`

Expected output (must match exactly):
```
count (1 bat + 2 live knives, not the dropped/expired ones): 3 expected 3
first row is the bat, instanceKey === weapon_key: { weapon_key: 'bat', instanceKey: 'bat' } expected {weapon_key: "bat", instanceKey: "bat"}
second row is a knife with a distinct instanceKey: knife knife:1 expected knife knife:1
third row is the OTHER knife, different instanceKey: knife knife:2 expected knife knife:2
instanceKeys are distinct: true expected true
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_knife2.js`

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: getWeaponsFor/pickWeaponForAttacker return instanceKey per weapon"
```

Then push.

---

### Task 3: `performKick` fumble-drop + main handler fumble-pickup

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Knife-aware fumble drop**

Find (search `if (roll === 0 && weapon.key)`):

```js
    if (roll === 0 && weapon.key) {
      db.prepare(
        "UPDATE weapon_ownership SET owner_type = 'dropped', owner_user_id = ?, owner_username = NULL, dropped_chat_id = ? WHERE weapon_key = ?"
      ).run(attacker.id, chatId, weapon.key);
      await bot.sendMessage(
        chatId,
        `😱 ${actorLabel} так мажет, что ${WEAPON_DEFS[weapon.key].name} вылетает из рук! Кто первым напишет что-нибудь в чат — подберёт.`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
```

Replace with:

```js
    if (roll === 0 && weapon.key) {
      if (weapon.instanceKey.startsWith('knife:')) {
        const knifeId = Number(weapon.instanceKey.slice('knife:'.length));
        db.prepare('UPDATE owned_knives SET owner_user_id = ?, owner_username = NULL, is_dropped = 1, dropped_chat_id = ? WHERE id = ?').run(attacker.id, chatId, knifeId);
      } else {
        db.prepare(
          "UPDATE weapon_ownership SET owner_type = 'dropped', owner_user_id = ?, owner_username = NULL, dropped_chat_id = ? WHERE weapon_key = ?"
        ).run(attacker.id, chatId, weapon.key);
      }
      await bot.sendMessage(
        chatId,
        `😱 ${actorLabel} так мажет, что ${WEAPON_DEFS[weapon.key].name} вылетает из рук! Кто первым напишет что-нибудь в чат — подберёт.`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
```

- [ ] **Step 2: Knife-aware fumble pickup**

Find (search `droppedHere` in the main `bot.on('message', ...)` handler):

```js
  const droppedHere = db.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'dropped' AND dropped_chat_id = ? AND owner_user_id != ?"
  ).all(msg.chat.id, msg.from.id);
  for (const row of droppedHere) {
    const changed = db.prepare(
      "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ?, dropped_chat_id = NULL WHERE weapon_key = ? AND owner_type = 'dropped' AND dropped_chat_id = ?"
    ).run(msg.from.id, msg.from.username, row.weapon_key, msg.chat.id);
    if (changed.changes > 0) {
      const def = WEAPON_DEFS[row.weapon_key];
      const finderLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      bot.sendMessage(msg.chat.id, `${def.emoji} ${finderLabel} находит и забирает ${def.accusative} — теперь бьёт ${def.instrumental} сам!`, threadOpts(msg)).catch(() => {});
    }
  }
```

Replace with:

```js
  const droppedHere = db.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'dropped' AND dropped_chat_id = ? AND owner_user_id != ?"
  ).all(msg.chat.id, msg.from.id);
  for (const row of droppedHere) {
    const changed = db.prepare(
      "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ?, dropped_chat_id = NULL WHERE weapon_key = ? AND owner_type = 'dropped' AND dropped_chat_id = ?"
    ).run(msg.from.id, msg.from.username, row.weapon_key, msg.chat.id);
    if (changed.changes > 0) {
      const def = WEAPON_DEFS[row.weapon_key];
      const finderLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      bot.sendMessage(msg.chat.id, `${def.emoji} ${finderLabel} находит и забирает ${def.accusative} — теперь бьёт ${def.instrumental} сам!`, threadOpts(msg)).catch(() => {});
    }
  }
  const droppedKnivesHere = db.prepare(
    'SELECT id FROM owned_knives WHERE is_dropped = 1 AND dropped_chat_id = ? AND owner_user_id != ?'
  ).all(msg.chat.id, msg.from.id);
  for (const row of droppedKnivesHere) {
    const changed = db.prepare(
      'UPDATE owned_knives SET owner_user_id = ?, owner_username = ?, is_dropped = 0, dropped_chat_id = NULL WHERE id = ? AND is_dropped = 1 AND dropped_chat_id = ?'
    ).run(msg.from.id, msg.from.username, row.id, msg.chat.id);
    if (changed.changes > 0) {
      const def = WEAPON_DEFS.knife;
      const finderLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      bot.sendMessage(msg.chat.id, `${def.emoji} ${finderLabel} находит и забирает ${def.accusative} — теперь бьёт ${def.instrumental} сам!`, threadOpts(msg)).catch(() => {});
    }
  }
```

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: knife-aware fumble drop and pickup"
```

Then push.

---

### Task 4: Knockout-loot steal offer — `instanceKey` in `callback_data` + handler rewrite

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Use `instanceKey` when building the steal-offer buttons**

Find (search `callback_data: \`steal_yes:\${attacker.id}`):

```js
      const buttons = heldWeapons.map(row => [{
        text: `🗡 Забрать ${WEAPON_DEFS[row.weapon_key].accusative}`,
        callback_data: `steal_yes:${attacker.id}:${target.id}:${row.weapon_key}`,
      }]);
```

Replace with:

```js
      const buttons = heldWeapons.map(row => [{
        text: `🗡 Забрать ${WEAPON_DEFS[row.weapon_key].accusative}`,
        callback_data: `steal_yes:${attacker.id}:${target.id}:${row.instanceKey}`,
      }]);
```

- [ ] **Step 2: Rewrite the `steal_yes:`/`steal_no:` callback branch**

Find (search `if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;` — this is the FULL branch, through its closing `});` right before the health-regen-tick comment block):

```js
  if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;

  const [action, attackerIdStr, victimIdStr, weaponKey] = data.split(':');
  const attackerId = Number(attackerIdStr);
  if (query.from.id !== attackerId) {
    return bot.answerCallbackQuery(query.id, { text: 'Это не твой трофей', show_alert: true }).catch(() => {});
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  // reply_markup must be passed explicitly (even empty) — editMessageText
  // otherwise keeps the original keyboard, which would leave the buttons
  // clickable again after this resolves.
  const editOpts = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };

  // Same guard steal_coins: uses below, shared across this whole offer
  // message — without it, tapping a weapon button and the wallet button
  // in quick succession (before editMessageText's round-trip visibly
  // disables the sibling buttons) could walk away with both, instead of
  // "one action per knockout" actually being enforced.
  const resolvedKey = `${chatId}:${messageId}`;
  if (resolvedGiveOffers.has(resolvedKey)) {
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  resolvedGiveOffers.add(resolvedKey);
  if (resolvedGiveOffers.size > MAX_RESOLVED_GIVE_OFFERS) resolvedGiveOffers.delete(resolvedGiveOffers.values().next().value);

  if (action === 'steal_no') {
    await bot.editMessageText('Оружие оставлено — трофей не забран.', editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  // weaponKey pins down exactly which button was pressed — re-verify live
  // that it's still on the victim (not moved by a crit-steal or a
  // different button click in the meantime) rather than trusting the
  // snapshot the offer was built from.
  const victimId = Number(victimIdStr);
  // Same expiry filter as getWeaponsFor — without it, a knife that
  // expired in the gap between the offer being posted and this click
  // could still be "stolen" here despite already being invisible
  // everywhere else (getWeaponsFor, /me, /find, /warriors).
  const row = db.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? AND weapon_key = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
  ).get(victimId, weaponKey);
  if (!row) {
    await bot.editMessageText('Этого оружия там уже нет — кто-то опередил.', editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  const def = WEAPON_DEFS[row.weapon_key];
  const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

  // 50/50 grip roll — even with the weapon confirmed still on the
  // victim, the downed victim gets one last chance to hang on to it
  // instead of the grab always succeeding outright.
  if (Math.random() < 0.5) {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(victimId);
    const victimLabel = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${victimId}`;
    await bot.editMessageText(`🤜 ${actorLabel} пытается вырвать ${def.accusative}, но ${victimLabel} вцепляется в неё мёртвой хваткой — не отдаёт!`, editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  db.prepare(
    "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?"
  ).run(query.from.id, query.from.username, row.weapon_key);
  await bot.editMessageText(`${def.emoji} ${actorLabel} обыскал(а) отключившегося и забрал(а) ${def.accusative}!`, editOpts).catch(() => {});
  bot.answerCallbackQuery(query.id).catch(() => {});
});
```

Replace with:

```js
  if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;

  // instanceKey may itself contain a colon ("knife:17") — reconstruct it
  // from every part after the first three, same colon-safe idiom /give
  // already uses for its own itemType, rather than a naive fixed-count
  // positional destructure that would truncate a knife's id.
  const [action, attackerIdStr, victimIdStr, ...instanceKeyParts] = data.split(':');
  const instanceKey = instanceKeyParts.join(':');
  const attackerId = Number(attackerIdStr);
  if (query.from.id !== attackerId) {
    return bot.answerCallbackQuery(query.id, { text: 'Это не твой трофей', show_alert: true }).catch(() => {});
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  // reply_markup must be passed explicitly (even empty) — editMessageText
  // otherwise keeps the original keyboard, which would leave the buttons
  // clickable again after this resolves.
  const editOpts = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };

  // Same guard steal_coins: uses below, shared across this whole offer
  // message — without it, tapping a weapon button and the wallet button
  // in quick succession (before editMessageText's round-trip visibly
  // disables the sibling buttons) could walk away with both, instead of
  // "one action per knockout" actually being enforced.
  const resolvedKey = `${chatId}:${messageId}`;
  if (resolvedGiveOffers.has(resolvedKey)) {
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  resolvedGiveOffers.add(resolvedKey);
  if (resolvedGiveOffers.size > MAX_RESOLVED_GIVE_OFFERS) resolvedGiveOffers.delete(resolvedGiveOffers.values().next().value);

  if (action === 'steal_no') {
    await bot.editMessageText('Оружие оставлено — трофей не забран.', editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  // instanceKey pins down exactly which button was pressed — re-verify
  // live that it's still on the victim (not moved by a different button
  // click in the meantime) rather than trusting the offer's snapshot.
  // Same expiry filter as getWeaponsFor — without it, an expired knife
  // could still be "stolen" here despite already being invisible
  // everywhere else (getWeaponsFor, /me, /find, /warriors).
  const victimId = Number(victimIdStr);
  let weaponKey;
  if (instanceKey.startsWith('knife:')) {
    const knifeId = Number(instanceKey.slice('knife:'.length));
    const knifeRow = db.prepare("SELECT id FROM owned_knives WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(knifeId, victimId);
    if (!knifeRow) {
      await bot.editMessageText('Этого оружия там уже нет — кто-то опередил.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }
    weaponKey = 'knife';
  } else {
    const row = db.prepare(
      "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? AND weapon_key = ? " +
      "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
    ).get(victimId, instanceKey);
    if (!row) {
      await bot.editMessageText('Этого оружия там уже нет — кто-то опередил.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }
    weaponKey = row.weapon_key;
  }

  const def = WEAPON_DEFS[weaponKey];
  const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

  // 50/50 grip roll — even with the weapon confirmed still on the
  // victim, the downed victim gets one last chance to hang on to it
  // instead of the grab always succeeding outright.
  if (Math.random() < 0.5) {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(victimId);
    const victimLabel = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${victimId}`;
    await bot.editMessageText(`🤜 ${actorLabel} пытается вырвать ${def.accusative}, но ${victimLabel} вцепляется в неё мёртвой хваткой — не отдаёт!`, editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  if (instanceKey.startsWith('knife:')) {
    const knifeId = Number(instanceKey.slice('knife:'.length));
    db.prepare('UPDATE owned_knives SET owner_user_id = ?, owner_username = ? WHERE id = ?').run(query.from.id, query.from.username, knifeId);
  } else {
    db.prepare(
      "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?"
    ).run(query.from.id, query.from.username, weaponKey);
  }
  await bot.editMessageText(`${def.emoji} ${actorLabel} обыскал(а) отключившегося и забрал(а) ${def.accusative}!`, editOpts).catch(() => {});
  bot.answerCallbackQuery(query.id).catch(() => {});
});
```

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_knife3.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT, expires_at INTEGER)`);
db.exec(`CREATE TABLE owned_knives (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, owner_username TEXT, is_dropped INTEGER NOT NULL DEFAULT 0, dropped_chat_id INTEGER, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);

// 1. instanceKey parsing survives a colon inside it
function parseInstanceKey(data) {
  const [action, attackerIdStr, victimIdStr, ...instanceKeyParts] = data.split(':');
  return { action, attackerIdStr, victimIdStr, instanceKey: instanceKeyParts.join(':') };
}
console.log('bare weapon_key survives:', parseInstanceKey('steal_yes:100:200:bat').instanceKey, 'expected bat');
console.log('knife instanceKey survives intact:', parseInstanceKey('steal_yes:100:200:knife:17').instanceKey, 'expected knife:17');

// 2. Knife steal transfer, atomic
const now = Math.floor(Date.now() / 1000);
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (1, 0, ?, ?)').run(now, now + 3600);
const knifeId = db.prepare('SELECT id FROM owned_knives WHERE owner_user_id = 1').get().id;

const reVerify = db.prepare("SELECT id FROM owned_knives WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(knifeId, 1);
console.log('re-verify finds the knife on victim 1:', !!reVerify, 'expected true');

db.prepare('UPDATE owned_knives SET owner_user_id = ?, owner_username = ? WHERE id = ?').run(2, 'thief', knifeId);
console.log('knife now owned by 2:', db.prepare('SELECT owner_user_id FROM owned_knives WHERE id = ?').get(knifeId), 'expected {owner_user_id: 2}');

// 3. Re-verify correctly fails once no longer on the original victim
const reVerifyAfter = db.prepare("SELECT id FROM owned_knives WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(knifeId, 1);
console.log('re-verify on original victim now fails (already stolen):', reVerifyAfter, 'expected undefined');

// 4. Expired knife is correctly invisible to re-verify
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (3, 0, ?, ?)').run(now, now - 10);
const expiredId = db.prepare('SELECT id FROM owned_knives WHERE owner_user_id = 3').get().id;
const reVerifyExpired = db.prepare("SELECT id FROM owned_knives WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(expiredId, 3);
console.log('expired knife invisible to re-verify:', reVerifyExpired, 'expected undefined');

// 5. Non-knife weapon path is completely unaffected (existing behavior)
db.prepare("INSERT INTO weapon_ownership (weapon_key, owner_type, owner_user_id) VALUES ('bat', 'human', 5)").run();
const batRow = db.prepare(
  "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? AND weapon_key = ? " +
  "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
).get(5, 'bat');
console.log('non-knife weapon lookup unaffected:', batRow, 'expected {weapon_key: "bat"}');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_knife3.js`

Expected output (must match exactly):
```
bare weapon_key survives: bat expected bat
knife instanceKey survives intact: knife:17 expected knife:17
re-verify finds the knife on victim 1: true expected true
knife now owned by 2: { owner_user_id: 2 } expected {owner_user_id: 2}
re-verify on original victim now fails (already stolen): undefined expected undefined
expired knife invisible to re-verify: undefined expected undefined
non-knife weapon lookup unaffected: { weapon_key: 'bat' } expected {weapon_key: "bat"}
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_knife3.js`

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: knife-aware knockout-loot weapon steal (instanceKey)"
```

Then push.

---

### Task 5: `/give`'s weapon transfer — `instanceKey` + `itemLabel` fix

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Use `instanceKey` when building `/give`'s weapon buttons**

Find (search `for (const { weapon_key } of weapons)`):

```js
  for (const { weapon_key } of weapons) {
    const def = WEAPON_DEFS[weapon_key];
    buttons.push([{ text: `${def.emoji} ${def.name}`, callback_data: `gv_i:${msg.from.id}:${target.id}:weapon:${weapon_key}` }]);
  }
```

Replace with:

```js
  for (const { weapon_key, instanceKey } of weapons) {
    const def = WEAPON_DEFS[weapon_key];
    buttons.push([{ text: `${def.emoji} ${def.name}`, callback_data: `gv_i:${msg.from.id}:${target.id}:weapon:${instanceKey}` }]);
  }
```

- [ ] **Step 2: Fix `itemLabel`'s `WEAPON_DEFS` lookup**

Find (search `function itemLabel`):

```js
function itemLabel(itemType) {
  if (itemType === 'elixir:health') return '🧪❤️ эликсир здоровья';
  if (itemType === 'elixir:energy') return '🧪⚡ эликсир энергии';
  const def = WEAPON_DEFS[itemType.slice('weapon:'.length)];
  return `${def.emoji} ${def.accusative}`;
}
```

Replace with:

```js
function itemLabel(itemType) {
  if (itemType === 'elixir:health') return '🧪❤️ эликсир здоровья';
  if (itemType === 'elixir:energy') return '🧪⚡ эликсир энергии';
  // itemType is "weapon:<instanceKey>" — for a knife that's
  // "weapon:knife:17", so WEAPON_DEFS needs just the "knife" part, not
  // the full instanceKey (which isn't a valid WEAPON_DEFS key itself).
  const instanceKey = itemType.slice('weapon:'.length);
  const weaponKey = instanceKey.startsWith('knife:') ? 'knife' : instanceKey;
  const def = WEAPON_DEFS[weaponKey];
  return `${def.emoji} ${def.accusative}`;
}
```

**This was a real, previously-undetected bug** — before this fix, sending a knife via `/give` would have thrown `TypeError: Cannot read properties of undefined (reading 'emoji')` the moment `itemLabel` was called on a `weapon:knife:<id>` item type, since `WEAPON_DEFS['knife:17']` is `undefined`. It never surfaced before this plan because knife was never `/give`-able while it was still a global singleton item (identified by bare `weapon_key`, which never contained a colon).

- [ ] **Step 3: Knife-aware `gv_i:` availability check**

Find (search `const weaponKey = itemType.slice('weapon:'.length);` inside the `gv_i:` branch — it's the FIRST of two occurrences of that exact line in the file, inside the `else` of `if (itemType === 'elixir:health') {...} else if (itemType === 'elixir:energy') {...} else {...}`):

```js
    } else {
      const weaponKey = itemType.slice('weapon:'.length);
      const row = db.prepare(
        "SELECT 1 FROM weapon_ownership WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
        "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
      ).get(weaponKey, senderId);
      available = !!row;
    }
```

Replace with:

```js
    } else {
      const instanceKey = itemType.slice('weapon:'.length);
      if (instanceKey.startsWith('knife:')) {
        const knifeId = Number(instanceKey.slice('knife:'.length));
        const row = db.prepare("SELECT 1 FROM owned_knives WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(knifeId, senderId);
        available = !!row;
      } else {
        const row = db.prepare(
          "SELECT 1 FROM weapon_ownership WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
          "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
        ).get(instanceKey, senderId);
        available = !!row;
      }
    }
```

- [ ] **Step 4: Knife-aware `gv_y:` transfer**

Find (search `const weaponKey = itemType.slice('weapon:'.length);` again — this is the SECOND occurrence, inside the `gv_y:`/`gv_n:` branch's final `else`):

```js
    } else {
      const weaponKey = itemType.slice('weapon:'.length);
      const result = db.prepare(
        "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? " +
        "WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
        "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
      ).run(targetId, query.from.username, weaponKey, senderId);
      transferred = result.changes > 0;
    }
```

Replace with:

```js
    } else {
      const instanceKey = itemType.slice('weapon:'.length);
      if (instanceKey.startsWith('knife:')) {
        const knifeId = Number(instanceKey.slice('knife:'.length));
        const result = db.prepare(
          "UPDATE owned_knives SET owner_user_id = ?, owner_username = ? WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')"
        ).run(targetId, query.from.username, knifeId, senderId);
        transferred = result.changes > 0;
      } else {
        const result = db.prepare(
          "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? " +
          "WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
          "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
        ).run(targetId, query.from.username, instanceKey, senderId);
        transferred = result.changes > 0;
      }
    }
```

- [ ] **Step 5: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_knife4.js`:

```js
const WEAPON_DEFS = { bat: { emoji: '🏏', accusative: 'биту' }, knife: { emoji: '🔪', accusative: 'ржавый нож' } };
function itemLabel(itemType) {
  if (itemType === 'elixir:health') return '🧪❤️ эликсир здоровья';
  if (itemType === 'elixir:energy') return '🧪⚡ эликсир энергии';
  const instanceKey = itemType.slice('weapon:'.length);
  const weaponKey = instanceKey.startsWith('knife:') ? 'knife' : instanceKey;
  const def = WEAPON_DEFS[weaponKey];
  return `${def.emoji} ${def.accusative}`;
}
console.log('itemLabel for a bat:', itemLabel('weapon:bat'), 'expected 🏏 биту');
console.log('itemLabel for a knife instance (was a crash before this fix):', itemLabel('weapon:knife:42'), 'expected 🔪 ржавый нож');

const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE owned_knives (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, owner_username TEXT, is_dropped INTEGER NOT NULL DEFAULT 0, dropped_chat_id INTEGER, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
const now = Math.floor(Date.now() / 1000);
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (10, 0, ?, ?)').run(now, now + 3600);
const knifeId = db.prepare('SELECT id FROM owned_knives WHERE owner_user_id = 10').get().id;

const available = !!db.prepare("SELECT 1 FROM owned_knives WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(knifeId, 10);
console.log('gv_i availability check finds sender\'s knife:', available, 'expected true');

const result = db.prepare(
  "UPDATE owned_knives SET owner_user_id = ?, owner_username = ? WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')"
).run(20, 'receiver', knifeId, 10);
console.log('gv_y transfer succeeds:', result.changes, 'expected 1');
console.log('knife now belongs to 20:', db.prepare('SELECT owner_user_id FROM owned_knives WHERE id = ?').get(knifeId), 'expected {owner_user_id: 20}');

const secondAttempt = db.prepare(
  "UPDATE owned_knives SET owner_user_id = ?, owner_username = ? WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')"
).run(30, 'thief', knifeId, 10); // sender 10 no longer owns it
console.log('replay against the original sender correctly fails:', secondAttempt.changes, 'expected 0');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_knife4.js`

Expected output (must match exactly):
```
itemLabel for a bat: 🏏 биту expected 🏏 биту
itemLabel for a knife instance (was a crash before this fix): 🔪 ржавый нож expected 🔪 ржавый нож
gv_i availability check finds sender's knife: true expected true
gv_y transfer succeeds: 1 expected 1
knife now belongs to 20: { owner_user_id: 20 } expected {owner_user_id: 20}
replay against the original sender correctly fails: 0 expected 0
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_knife4.js`

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "fix: /give knife transfer (instanceKey) + itemLabel crash on knife item type"
```

Then push.

---

### Task 6: `/pick`'s knife claim becomes an `INSERT`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Rewrite the knife branch**

Find (search `WHERE weapon_key = 'knife'` inside `bot.onText(/\/pick\b/i`):

```js
  } else {
    const expiresAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    db.prepare("UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ?, expires_at = ? WHERE weapon_key = 'knife'").run(msg.from.id, msg.from.username, expiresAt);
    bot.sendMessage(msg.chat.id, `📦🔪 ${actorLabel} открыл ящик и нашёл ржавый нож! Урон ×1.5, рассыплется через 3 часа.`, threadOpts(msg)).catch(() => {});
  }
```

Replace with:

```js
  } else {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 3 * 3600;
    db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)').run(msg.from.id, msg.from.username, now, expiresAt);
    bot.sendMessage(msg.chat.id, `📦🔪 ${actorLabel} открыл ящик и нашёл ржавый нож! Урон ×1.5, рассыплется через 3 часа.`, threadOpts(msg)).catch(() => {});
  }
```

(This is strictly simpler than before — a fresh `INSERT` every time, no shared-singleton race to guard against.)

- [ ] **Step 2: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: /pick's knife claim inserts a fresh owned_knives row"
```

Then push.

---

### Task 7: `arenaTick` — decay loop over all knives, remove the scarcity gate

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Rewrite the decay check**

Find (search `function arenaTick`, then the knife-decay block right after `const now = ...`):

```js
    // Knife decay — checked every tick regardless of whether a new drop
    // fires this time, since its 3h timer runs independently of the
    // drop schedule (it started whenever it was last picked up, not
    // whenever the crate wave landed).
    const knifeRow = db.prepare("SELECT owner_user_id, owner_username, expires_at FROM weapon_ownership WHERE weapon_key = 'knife' AND owner_type = 'human'").get();
    if (knifeRow && knifeRow.expires_at && knifeRow.expires_at < now) {
      db.prepare("UPDATE weapon_ownership SET owner_type = 'none', owner_user_id = NULL, owner_username = NULL, expires_at = NULL WHERE weapon_key = 'knife'").run();
      const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(knifeRow.owner_user_id);
      const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${knifeRow.owner_user_id}`;
      bot.sendMessage(ARENA_CHAT_ID, `🔪💨 Ржавый нож у ${label} рассыпался от старости!`).catch(() => {});
    }
```

Replace with:

```js
    // Knife decay — checked every tick regardless of whether a new drop
    // fires this time, since each knife's 3h timer runs independently of
    // both the drop schedule and every other knife (it started whenever
    // THAT knife was acquired, not when any crate wave landed). Only
    // is_dropped = 0 knives decay — same "expiry effectively pauses while
    // fumble-dropped and unclaimed" quirk the old singleton-knife code
    // already had (it only ever checked owner_type = 'human'), carried
    // over unchanged rather than "fixed" as part of this refactor.
    const expiredKnives = db.prepare("SELECT id, owner_user_id FROM owned_knives WHERE is_dropped = 0 AND expires_at < ?").all(now);
    for (const knifeRow of expiredKnives) {
      db.prepare('DELETE FROM owned_knives WHERE id = ?').run(knifeRow.id);
      const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(knifeRow.owner_user_id);
      const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${knifeRow.owner_user_id}`;
      bot.sendMessage(ARENA_CHAT_ID, `🔪💨 Ржавый нож у ${label} рассыпался от старости!`).catch(() => {});
    }
```

- [ ] **Step 2: Remove the "only 1 knife" scarcity gate from the crate-drop composition**

Find (search `Only 1 knife ever exists at a time`):

```js
    const newBatchId = state.current_batch_id + 1;
    // Only 1 knife ever exists at a time (weapon_ownership has exactly
    // one 'knife' row) — since the drop cadence (3h) equals the knife's
    // own decay timer (3h), a new batch landing while the previous
    // knife is still held (or lying fumble-dropped, unclaimed) would
    // otherwise silently steal/overwrite it via /pick's unconditional
    // UPDATE. The decay check above already reverts an expired one to
    // 'none' earlier in this same tick, so re-querying here reflects
    // that immediately — only offer a fresh knife when none currently
    // exists.
    const knifeNow = db.prepare("SELECT owner_type FROM weapon_ownership WHERE weapon_key = 'knife'").get();
    const crateTypes = knifeNow.owner_type === 'none'
      ? ['health_elixir', 'health_elixir', 'energy_elixir', 'energy_elixir', 'knife']
      : ['health_elixir', 'health_elixir', 'energy_elixir', 'energy_elixir'];
```

Replace with:

```js
    const newBatchId = state.current_batch_id + 1;
    // No more scarcity gate needed — knives are no longer a shared
    // singleton (see docs/superpowers/specs/2026-08-25-knife-multi-
    // instance-design.md), so every batch always includes one.
    const crateTypes = ['health_elixir', 'health_elixir', 'energy_elixir', 'energy_elixir', 'knife'];
```

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_knife5.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE owned_knives (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, owner_username TEXT, is_dropped INTEGER NOT NULL DEFAULT 0, dropped_chat_id INTEGER, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);

const now = Math.floor(Date.now() / 1000);
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (1, 0, ?, ?)').run(now - 7200, now - 10); // expired, held -> must decay
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (2, 0, ?, ?)').run(now - 100, now + 3600); // still fresh -> must NOT decay
db.prepare('INSERT INTO owned_knives (owner_user_id, is_dropped, acquired_at, expires_at) VALUES (3, 1, ?, ?)').run(now - 7200, now - 10); // expired but DROPPED -> must NOT decay (matches old owner_type='human' filter)

function decayTick(nowArg) {
  const expiredKnives = db.prepare('SELECT id, owner_user_id FROM owned_knives WHERE is_dropped = 0 AND expires_at < ?').all(nowArg);
  for (const row of expiredKnives) {
    db.prepare('DELETE FROM owned_knives WHERE id = ?').run(row.id);
  }
  return expiredKnives.length;
}

const decayedCount = decayTick(now);
console.log('exactly 1 knife decayed this tick:', decayedCount, 'expected 1');
console.log('remaining knives:', db.prepare('SELECT owner_user_id, is_dropped FROM owned_knives ORDER BY owner_user_id').all(), 'expected [{owner_user_id: 2, is_dropped: 0}, {owner_user_id: 3, is_dropped: 1}]');

// Crate composition always includes knife now
const crateTypes = ['health_elixir', 'health_elixir', 'energy_elixir', 'energy_elixir', 'knife'];
console.log('crate batch always has exactly one knife:', crateTypes.filter(t => t === 'knife').length, 'expected 1');
console.log('crate batch size unchanged at 5:', crateTypes.length, 'expected 5');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_knife5.js`

Expected output (must match exactly):
```
exactly 1 knife decayed this tick: 1 expected 1
remaining knives: [ { owner_user_id: 2, is_dropped: 0 }, { owner_user_id: 3, is_dropped: 1 } ] expected [{owner_user_id: 2, is_dropped: 0}, {owner_user_id: 3, is_dropped: 1}]
crate batch always has exactly one knife: 1 expected 1
crate batch size unchanged at 5: 5 expected 5
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_knife5.js`

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: arenaTick decays every knife independently, drops always include one"
```

Then push.

---

### Task 8: `/me` display — remaining time for each held knife

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Add the knife branch to the weapon display loop**

Find (search `heldWeapons.forEach`):

```js
  const heldWeapons = getWeaponsFor('human', msg.from.id);
  heldWeapons.forEach((row, i) => {
    const def = WEAPON_DEFS[row.weapon_key];
    const slotTag = `/kick${i + 1}`;
    if (row.weapon_key === 'carrot') {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: случайное место попадания, от лечения до мгновенного нокаута`);
    } else {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: урон ×${def.multiplier}`);
    }
  });
```

Replace with:

```js
  const heldWeapons = getWeaponsFor('human', msg.from.id);
  heldWeapons.forEach((row, i) => {
    const def = WEAPON_DEFS[row.weapon_key];
    const slotTag = `/kick${i + 1}`;
    if (row.weapon_key === 'knife') {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: урон ×${def.multiplier} (осталось ${formatExpire(row.expiresAt)})`);
    } else if (row.weapon_key === 'carrot') {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: случайное место попадания, от лечения до мгновенного нокаута`);
    } else {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: урон ×${def.multiplier}`);
    }
  });
```

(`row.expiresAt` is populated by `getWeaponsFor` for knife rows specifically, per Task 2 — `undefined` for every other weapon, which is fine since this branch only reads it when `row.weapon_key === 'knife'`.)

- [ ] **Step 2: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: /me shows remaining time for each held knife"
```

Then push.

---

### Task 9: `/shop`'s weapon category — buy/sell a knife

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Un-placeholder the weapons category button**

Find (search `function shopCategoryKeyboard`):

```js
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

Replace with:

```js
function shopCategoryKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧪 Эликсиры', callback_data: 'shop:elixirs' }],
      [{ text: '🗡 Оружие', callback_data: 'shop:weapons' }],
      [{ text: '👕 Одежда (скоро)', callback_data: 'shop:soon' }],
    ],
  };
}
```

- [ ] **Step 2: Add `weaponShopText`/`weaponShopKeyboard`**

Insert right after `elixirShopKeyboard`'s closing `}` (search for `function elixirShopKeyboard`, insert after its own closing `}`, before `bot.onText(/\/shop\b/i`):

```js
function weaponShopText(actorLabel, coins, knifeCount) {
  return `🗡 ${actorLabel}, магазин оружия. Баланс: ${coins} монет. У тебя ножей: ${knifeCount}.\n` +
    `Купить ржавый нож — 5 монет\n` +
    `Продать ржавый нож — 3 монеты`;
}
function weaponShopKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔪 Купить (5)', callback_data: 'shop:buy:knife' }, { text: '🔪 Продать (3)', callback_data: 'shop:sell:knife' }],
      [{ text: '⬅️ Назад', callback_data: 'shop:back' }],
    ],
  };
}
```

- [ ] **Step 3: Add the `shop:weapons` navigation branch**

Find (search `if (data === 'shop:elixirs') {`, this whole branch through its closing `}`):

```js
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
```

Insert immediately **after** it (still before the `shop:buy:`/`shop:sell:` combined branch):

```js
  if (data === 'shop:weapons') {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    ensureStatsRow(query.from.id);
    const coinsRow = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(query.from.id);
    const knifeCount = db.prepare("SELECT COUNT(*) AS n FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(query.from.id).n;
    await bot.editMessageText(weaponShopText(actorLabel, coinsRow.coins, knifeCount), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: weaponShopKeyboard(),
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
```

- [ ] **Step 4: Extend the buy/sell branch with knife handling**

Find (search `if (data.startsWith('shop:buy:') || data.startsWith('shop:sell:')) {` — this whole branch through its closing `}`):

```js
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

Replace with:

```js
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
    } else if (data === 'shop:buy:knife') {
      ok = !!db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
      if (ok) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)')
          .run(userId, query.from.username, now, now + 3 * 3600);
      }
    } else if (data === 'shop:sell:knife') {
      const oldest = db.prepare("SELECT id FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now') ORDER BY id LIMIT 1").get(userId);
      ok = !!oldest;
      if (ok) {
        db.prepare('DELETE FROM owned_knives WHERE id = ?').run(oldest.id);
        db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
      }
    }

    if (!ok) {
      const failText = data.startsWith('shop:buy:') ? 'Не хватает монет' : 'Нечего продать';
      return bot.answerCallbackQuery(query.id, { text: failText, show_alert: true }).catch(() => {});
    }

    const isWeaponAction = data === 'shop:buy:knife' || data === 'shop:sell:knife';
    if (isWeaponAction) {
      const coinsRow = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(userId);
      const knifeCount = db.prepare("SELECT COUNT(*) AS n FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(userId).n;
      await bot.editMessageText(weaponShopText(actorLabel, coinsRow.coins, knifeCount), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: weaponShopKeyboard(),
      }).catch(() => {});
    } else {
      const stats = db.prepare('SELECT coins, health_elixirs, energy_elixirs FROM pvp_stats WHERE user_id = ?').get(userId);
      await bot.editMessageText(elixirShopText(actorLabel, stats), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: elixirShopKeyboard(),
      }).catch(() => {});
    }
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
```

- [ ] **Step 5: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Write and run the isolated verification script**

Create `c:\Users\123\Projects\tg-bot\_verify_knife6.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE pvp_stats (user_id INTEGER PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE owned_knives (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, owner_username TEXT, is_dropped INTEGER NOT NULL DEFAULT 0, dropped_chat_id INTEGER, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);

db.prepare('INSERT INTO pvp_stats (user_id, coins) VALUES (1, 12)').run();
db.prepare('INSERT INTO pvp_stats (user_id, coins) VALUES (2, 3)').run();

function buyKnife(userId) {
  const ok = !!db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
  if (ok) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)').run(userId, 'x', now, now + 3 * 3600);
  }
  return ok;
}
function sellKnife(userId) {
  const oldest = db.prepare("SELECT id FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now') ORDER BY id LIMIT 1").get(userId);
  if (!oldest) return false;
  db.prepare('DELETE FROM owned_knives WHERE id = ?').run(oldest.id);
  db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
  return true;
}

console.log('user 1 buys a knife:', buyKnife(1), 'expected true');
console.log('user 1 coins after buy (12-5):', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=1').get(), 'expected {coins: 7}');
console.log('user 1 knife count:', db.prepare("SELECT COUNT(*) AS n FROM owned_knives WHERE owner_user_id=1 AND is_dropped=0").get(), 'expected {n: 1}');

console.log('user 1 buys a second knife (multi-instance!):', buyKnife(1), 'expected true');
console.log('user 1 now owns 2 knives at once:', db.prepare("SELECT COUNT(*) AS n FROM owned_knives WHERE owner_user_id=1 AND is_dropped=0").get(), 'expected {n: 2}');

console.log('user 2 (3 coins) cannot afford a knife:', buyKnife(2), 'expected false');

console.log('user 1 sells one knife:', sellKnife(1), 'expected true');
console.log('user 1 coins after sell (7-10+3, i.e. 2+3):', db.prepare('SELECT coins FROM pvp_stats WHERE user_id=1').get(), 'expected {coins: 5}');
console.log('user 1 still owns 1 knife (sold the oldest, one remains):', db.prepare("SELECT COUNT(*) AS n FROM owned_knives WHERE owner_user_id=1 AND is_dropped=0").get(), 'expected {n: 1}');

console.log('user 2 has nothing to sell:', sellKnife(2), 'expected false');
```

Run: `cd c:\Users\123\Projects\tg-bot && node _verify_knife6.js`

Expected output (must match exactly):
```
user 1 buys a knife: true expected true
user 1 coins after buy (12-5): { coins: 7 } expected {coins: 7}
user 1 knife count: { n: 1 } expected {n: 1}
user 1 buys a second knife (multi-instance!): true expected true
user 1 now owns 2 knives at once: { n: 2 } expected {n: 2}
user 2 (3 coins) cannot afford a knife: false expected false
user 1 sells one knife: true expected true
user 1 coins after sell (7-10+3, i.e. 2+3): { coins: 5 } expected {coins: 5}
user 1 still owns 1 knife (sold the oldest, one remains): { n: 1 } expected {n: 1}
user 2 has nothing to sell: false expected false
```

Delete the scratch script once confirmed: `rm c:\Users\123\Projects\tg-bot\_verify_knife6.js`

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat: /shop weapon category — buy/sell knives"
```

Then push.

---

### Task 10: `/helppvp` text + retire the old seed-row `INSERT OR IGNORE`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js`

- [ ] **Step 1: Remove the now-dead knife seed row**

Find (search `VALUES ('knife', NULL, 'none'`):

```js
// Unlike every weapon above, the knife starts owned by nobody at all —
// owner_type = 'none' matches neither 'human' nor 'troll' nor 'dropped'
// in any existing filter, so it's invisible everywhere until /pick
// hands it to someone for the first time.
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('knife', NULL, 'none', NULL, NULL)").run();
```

Delete this whole block (both the comment and the `INSERT OR IGNORE` line) — knife no longer lives in `weapon_ownership` at all as of Task 1's migration, and nothing reads this row anymore after Tasks 2-9 (every knife-touching site now goes through `owned_knives` exclusively). Leaving a dead seed row here would be actively misleading to a future reader.

- [ ] **Step 2: Update the `/shop` help line**

Find (search `/shop — магазин: эликсиры за монеты`):

```js
    '/shop — магазин: эликсиры за монеты (купить 5 монет, продать за 3); оружие и одежда скоро',
```

Replace with:

```js
    '/shop — магазин: эликсиры и ржавый нож (купить 5 монет, продать за 3); одежда скоро',
```

- [ ] **Step 3: Syntax-check**

Run: `cd c:\Users\123\Projects\tg-bot && node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "chore: remove dead knife seed row, update /shop help text"
```

Then push.

---

### Task 11: Manual verification (left to user)

Not automated. After all tasks are pushed and the user restarts the bot (`pm2 restart tg-bot`), verify manually in "Поединки":

- [ ] `/shop` → "Оружие" (no longer "скоро") → buy/sell sub-menu appears with correct balance/knife count.
- [ ] Buy a knife with enough coins → balance drops 5, knife count rises, `/me` shows it with remaining time.
- [ ] Buy a SECOND knife while already holding one → confirm you now hold 2 knives simultaneously, both shown separately in `/me` (`/kick1`, `/kick2`), each with its own independent remaining time.
- [ ] Sell a knife → coins rise by 3, knife count drops by 1 (confirm it's the OLDEST one that disappears if you held 2 with different remaining times).
- [ ] `/pick` a knife crate from the arena → confirm it creates an independent knife (doesn't collide with any knife bought from the shop).
- [ ] Two different players both hold a knife at the same time (one from `/pick`, one bought) → confirm both work independently in combat, decay independently, don't interfere with each other.
- [ ] Fumble a knife attack (natural 0) → confirm it drops in the chat and a DIFFERENT player can pick it up; confirm the original owner's OTHER knives (if they had more than one) are unaffected.
- [ ] Get knocked out while holding 2 knives → confirm the knockout-loot offer shows a separate "Забрать ржавый нож" button for EACH knife (not just one shared button), and stealing one leaves the other with the original owner.
- [ ] `/give` a knife to another warrior while holding 2 → confirm you can choose which knife-labeled button (there should be one per knife) and only that specific one transfers, the other stays with you.
- [ ] Let a knife's 3-hour timer expire naturally → confirm the "рассыпался от старости" announcement fires, and confirm it does NOT affect any other knife the same player might hold.
- [ ] Confirm the arena crate drop always includes a knife crate now, every wave, regardless of how many knives currently exist anywhere.

---

## Self-Review

**Spec coverage:** schema + migration (✅ Task 1), `instanceKey` abstraction in `getWeaponsFor`/`pickWeaponForAttacker` (✅ Task 2), fumble drop/pickup (✅ Task 3), knockout-loot steal (✅ Task 4), `/give` transfer + `itemLabel` fix (✅ Task 5), `/pick` (✅ Task 6), `arenaTick` decay + scarcity-gate removal (✅ Task 7), `/me` display (✅ Task 8), `/shop` weapon category (✅ Task 9), cleanup + help text (✅ Task 10). No troll-bot changes anywhere (✅).

**Placeholder scan:** No TBD/TODO; every step has complete code or an exact command with expected output.

**Type consistency:** `instanceKey` is a string everywhere it appears — `weapon_key` itself for the 6 singletons, `"knife:" + id` for a knife — produced exactly once (Task 2's `getWeaponsFor`) and consumed identically by every downstream site (Tasks 3-5, 9) via the same `instanceKey.startsWith('knife:')` branch and the same `Number(instanceKey.slice('knife:'.length))` id-extraction idiom, no drift between call sites. `owned_knives`'s column set (`id`, `owner_user_id`, `owner_username`, `is_dropped`, `dropped_chat_id`, `acquired_at`, `expires_at`) is used identically across every task that touches it (Tasks 1, 3, 4, 5, 6, 7, 8, 9) — verified no task invents a differently-named column.

**Known, intentionally-preserved behavior quirks (not bugs to fix in this plan):** a fumble-dropped-but-unclaimed knife doesn't decay while lying unclaimed (Task 7, matches the pre-refactor singleton's exact behavior); the shop always sells the OLDEST held knife first when selling (Task 9, a deliberate, simple, deterministic tie-break when a player holds several).
