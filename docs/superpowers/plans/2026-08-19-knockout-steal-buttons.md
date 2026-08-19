# Knockout Weapon-Steal Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `/kick` hit drops the victim's health to 0, offer the attacker inline "🗡 Отобрать оружие" / "🤝 Оставить" buttons (if the victim holds a real weapon) that only that attacker can act on, guaranteeing a steal on accept.

**Architecture:** One new block inside the existing `/kick` handler that checks `targetHealthAfter === 0` and sends a message with an inline keyboard when the victim currently holds a real weapon. One new `bot.on('callback_query', ...)` handler — net-new infrastructure for this file — that validates the clicker is the authorized attacker, then transfers ownership (or no-ops) and clears the message's keyboard either way.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api` (`reply_markup`/`inline_keyboard`, `bot.on('callback_query', ...)`, `bot.answerCallbackQuery`, `bot.editMessageText`). No test framework — verification is `node --check` for syntax, one isolated `node -e` script for the pure DB query logic, then a live smoke test (this feature is mostly Telegram API interaction, which can't be unit-tested the way earlier features' pure DB logic could).

**Spec:** `docs/superpowers/specs/2026-08-19-knockout-steal-buttons-design.md`

---

### Task 1: Knockout offer in `/kick`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1178-1200` (end of the `/kick` handler, right after the crit block)

- [x] **Step 1: Add the knockout-offer block after the crit block**

Find:

```js
  if (roll >= getCritThreshold(msg.from.id)) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healHours = applyInjury(target.id, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      msg.chat.id,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healHours} ч).`,
      threadOpts(msg)
    ).catch(() => {});
    if (weapon.key === 'horns') {
      await bot.sendMessage(msg.chat.id, `🐂 ${actorLabel} насадила ${targetLabel} на рога!`, threadOpts(msg)).catch(() => {});
    }
    const stolenKey = maybeStealWeapon(target.id, { type: 'human', userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      await bot.sendMessage(
        msg.chat.id,
        `${stolenDef.emoji} ${actorLabel} отобрал ${stolenDef.accusative} у ${targetLabel} и теперь бьёт ${stolenDef.instrumental} сам!`,
        threadOpts(msg)
      ).catch(() => {});
    }
  }
});
```

Replace with:

```js
  if (roll >= getCritThreshold(msg.from.id)) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healHours = applyInjury(target.id, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      msg.chat.id,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healHours} ч).`,
      threadOpts(msg)
    ).catch(() => {});
    if (weapon.key === 'horns') {
      await bot.sendMessage(msg.chat.id, `🐂 ${actorLabel} насадила ${targetLabel} на рога!`, threadOpts(msg)).catch(() => {});
    }
    const stolenKey = maybeStealWeapon(target.id, { type: 'human', userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      await bot.sendMessage(
        msg.chat.id,
        `${stolenDef.emoji} ${actorLabel} отобрал ${stolenDef.accusative} у ${targetLabel} и теперь бьёт ${stolenDef.instrumental} сам!`,
        threadOpts(msg)
      ).catch(() => {});
    }
  }

  // Knockout weapon-steal offer — additive to the silent 5% crit-steal
  // above, not a replacement (see docs/superpowers/specs/
  // 2026-08-19-knockout-steal-buttons-design.md). Looked up live rather
  // than from a value cached earlier in this handler: if the crit
  // block's own maybeStealWeapon just moved the weapon to msg.from.id,
  // this SELECT correctly finds nothing left on target.id, so no
  // redundant "steal the weapon you already just got" offer appears.
  if (targetHealthAfter === 0) {
    const heldWeapon = db.prepare(
      "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?"
    ).get(target.id);
    if (heldWeapon) {
      const def = WEAPON_DEFS[heldWeapon.weapon_key];
      await bot.sendMessage(
        msg.chat.id,
        `${targetLabel} в отключке — с ним ${def.accusative}. Забрать?`,
        threadOpts(msg, {
          reply_markup: {
            inline_keyboard: [[
              { text: '🗡 Отобрать оружие', callback_data: `steal_yes:${msg.from.id}:${target.id}` },
              { text: '🤝 Оставить', callback_data: `steal_no:${msg.from.id}` },
            ]],
          },
        })
      ).catch(() => {});
    }
  }
});
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Verify the live weapon-lookup query in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, seed_username TEXT, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT)\`);
db.prepare(\"INSERT INTO weapon_ownership (weapon_key, owner_type, owner_user_id, owner_username) VALUES ('axe', 'human', 111, 'Victim')\").run();
db.prepare(\"INSERT INTO weapon_ownership (weapon_key, owner_type, owner_user_id, owner_username) VALUES ('bat', 'troll', NULL, NULL)\").run();

function getHeldWeapon(userId) {
  return db.prepare(\"SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?\").get(userId);
}

console.log('victim (111) holds:', getHeldWeapon(111), 'expected { weapon_key: \'axe\' }');
console.log('non-holder (222) holds:', getHeldWeapon(222), 'expected undefined');

db.prepare(\"UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?\").run(333, 'Attacker', 'axe');
console.log('victim (111) holds after steal:', getHeldWeapon(111), 'expected undefined');
console.log('new holder (333) holds:', getHeldWeapon(333), 'expected { weapon_key: \'axe\' }');
"
```

Expected output (in order):
```
victim (111) holds: { weapon_key: 'axe' } expected { weapon_key: 'axe' }
non-holder (222) holds: undefined expected undefined
victim (111) holds after steal: undefined expected undefined
new holder (333) holds: { weapon_key: 'axe' } expected { weapon_key: 'axe' }
```

- [x] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: offer knockout weapon-steal buttons in /kick"
git push
```

---

### Task 2: `callback_query` handler

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:2228-2229` (right after the existing `bot.on('polling_error', ...)`/`bot.on('message', ...)` registrations)

- [x] **Step 1: Add the callback_query handler**

Find:

```js
bot.on('polling_error', (err) => console.error('polling_error:', err.message));
bot.on('message', (msg) => console.log('сообщение от:', msg.from?.username, 'id:', msg.from?.id, 'текст:', msg.text));
```

Replace with:

```js
bot.on('polling_error', (err) => console.error('polling_error:', err.message));
bot.on('message', (msg) => console.log('сообщение от:', msg.from?.username, 'id:', msg.from?.id, 'текст:', msg.text));

// Knockout weapon-steal buttons (see docs/superpowers/specs/2026-08-19-
// knockout-steal-buttons-design.md and the /kick handler above, which
// sends the offer this responds to). callback_data never carries the
// weapon key — ownership is re-read live at click time, same principle
// as the offer itself, so a delayed click on a weapon someone else
// already took correctly reports "already gone" instead of stealing a
// stale snapshot.
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;

  const [action, attackerIdStr, victimIdStr] = data.split(':');
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

  if (action === 'steal_no') {
    await bot.editMessageText('Оружие оставлено — трофей не забран.', editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  const victimId = Number(victimIdStr);
  const row = db.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?"
  ).get(victimId);
  if (!row) {
    await bot.editMessageText('Оружия там уже нет — кто-то опередил.', editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  const def = WEAPON_DEFS[row.weapon_key];
  db.prepare(
    "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?"
  ).run(query.from.id, query.from.username, row.weapon_key);
  const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
  await bot.editMessageText(`${def.emoji} ${actorLabel} обыскал(а) отключившегося и забрал(а) ${def.accusative}!`, editOpts).catch(() => {});
  bot.answerCallbackQuery(query.id).catch(() => {});
});
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: handle knockout weapon-steal button clicks"
git push
```

---

### Task 3: Manual end-to-end verification

**Files:** none (verification only, against the running bot — deploy is the user's own GitHub-based flow)

- [ ] **Step 1: Confirm buttons appear only when the victim holds a weapon**

Knock someone with NO real weapon down to 0 health via `/kick` (repeated hits). Expected: normal knockout (mute), no button message. Then knock someone who DOES hold a real weapon (bat/axe/scissors/crutch/horns) down to 0. Expected: a new message with "🗡 Отобрать оружие" / "🤝 Оставить" buttons appears.

- [ ] **Step 2: Confirm only the attacker can click**

Have a different user (not the one who landed the knockout hit) click either button. Expected: a toast alert "Это не твой трофей", the message is unchanged (buttons still present, text unchanged).

- [ ] **Step 3: Confirm "Отобрать" transfers ownership**

As the authorized attacker, click "🗡 Отобрать оружие". Expected: the message edits to confirm the steal and the buttons disappear; `/me` for the attacker now lists that weapon; `/me` for the original victim no longer lists it.

- [ ] **Step 4: Confirm "Оставить" leaves ownership unchanged**

Repeat the knockout with a different weapon-holding victim, then click "🤝 Оставить". Expected: the message edits to say the weapon was left, buttons disappear, `/me` shows the weapon still with the original victim.

- [ ] **Step 5: Confirm the offer is one-shot**

After either button is clicked in Steps 3-4, confirm there is nothing left to click on that message (buttons are gone) — no way to double-resolve the same offer.

- [ ] **Step 6: Confirm no offer when the crit-steal already fired on the same hit**

If a knockout hit happens to also be a crit where the existing 5% `maybeStealWeapon` succeeds (hard to force without a temporary roll override — optional/best-effort to observe naturally), confirm no redundant button offer appears, since the weapon is already gone from the victim by the time the knockout check runs.

- [ ] **Step 7: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as the earlier tasks.
