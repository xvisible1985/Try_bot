# Knockout weapon-steal buttons — design

## Purpose

Add a second, additive way to steal a real weapon (bat/axe/scissors/
crutch/horns) in `/kick`: whoever lands the finishing blow that drops
the victim's health to 0 (the same moment that already mutes them for
30 minutes) gets an inline-button offer — **🗡 Отобрать оружие** /
**🤝 Оставить** — to guarantee-steal whatever real weapon the victim
currently holds. Only the person who landed that knockout hit can act
on the buttons.

This is **additive**, not a replacement: the existing silent 5%-on-crit
auto-steal (`maybeStealWeapon`, called at every crit regardless of
whether it's fatal) is untouched and keeps working exactly as today.
Scope is `tg-bot`'s `/kick` only — troll-bot is not touched (per the
user's explicit choice: only human-knocks-out-human via `/kick`
counts; troll-vs-human knockouts, in either direction, don't get this
offer, since a troll can't click a button and the user chose not to
extend this to human-knocks-out-troll either).

## Design

### Trigger

Inside `/kick`, after the existing crit block (`bot.js:1178-1199`),
add a knockout check keyed off `targetHealthAfter === 0` (the same
value `damageHuman`'s `RETURNING health` already produces, and the
same condition `damageHuman` internally uses to mute the victim):

```js
if (targetHealthAfter === 0) {
  const heldWeapon = db.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?"
  ).get(target.id);
  if (heldWeapon) {
    const def = WEAPON_DEFS[heldWeapon.weapon_key];
    await bot.sendMessage(
      msg.chat.id,
      `${targetLabel} в отключке — с ним ${def.accusative}. Забрать?`,
      {
        ...threadOpts(msg),
        reply_markup: {
          inline_keyboard: [[
            { text: '🗡 Отобрать оружие', callback_data: `steal_yes:${msg.from.id}:${target.id}` },
            { text: '🤝 Оставить', callback_data: `steal_no:${msg.from.id}` },
          ]],
        },
      }
    ).catch(() => {});
  }
}
```

**Why look up the weapon live at offer-time, not from a value cached
earlier in the handler:** if the crit block's own `maybeStealWeapon`
already moved the weapon to the attacker on this same hit (its 5%
chance, checked independently a few lines above), this fresh `SELECT
... WHERE owner_user_id = target.id` correctly finds nothing — the
weapon isn't the victim's anymore — so no redundant "steal the weapon
you already just got" offer appears. No special-casing needed; it
falls out of always reading current state.

If the victim holds none of the 5 real weapons, `heldWeapon` is
`undefined` and nothing is sent — a knockout with no weapon to loot
looks exactly like it does today.

### Buttons and restriction

`callback_data` encodes only IDs, never the weapon key — the actual
steal handler re-reads current ownership at click time (see above; the
same live-lookup principle applies to a delayed click too, e.g. if the
weapon was independently stolen by someone else between the offer and
the click).

New `bot.on('callback_query', ...)` handler (net-new infrastructure
for `tg-bot` — no inline keyboards exist in this file today; troll-bot
has an unrelated, unrestricted one for its `/troll` status card that
this doesn't reuse, since that pattern lets any user act as themselves
and this needs the opposite: one specific authorized user only):

```js
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

**`reply_markup: { inline_keyboard: [] }` is required on every
`editMessageText` call, even the "already gone"/rejection paths** —
Telegram's Bot API keeps the original keyboard on an edit unless a new
(possibly empty) one is explicitly supplied. Passing an empty array
removes the buttons, which is what makes the offer effectively
one-shot: once edited, there is nothing left to click, so no separate
"already resolved" state needs to be tracked in the database. A
same-instant double-click race is not a concern either — better-sqlite3
is synchronous and Node is single-threaded, so the first callback's
`UPDATE`/edit fully completes before a second one can begin executing;
whichever query object is processed second will simply find the
weapon already gone (empty `row`) if it was a second "steal" click, or
just redundantly re-edit an already-edited message if it was a race on
the same click.

### Who can never see an offer

- The victim holds no real weapon → no message sent at all.
- The knockout hit itself already triggered `maybeStealWeapon` (5%
  crit chance) → weapon is already gone from the victim by the time
  this check runs, so no offer.
- troll-bot's own knockouts (troll finishes a human, or a human
  finishes the troll via `/fight`) → out of scope entirely; the
  existing silent 5%-on-crit steal is the only mechanism there,
  unchanged.

## Out of scope

- Any change to `maybeStealWeapon`'s existing 5%-on-crit behavior.
- Any change to troll-bot.
- A timeout/expiry on the offer — buttons simply stay clickable
  (harmlessly, for the one authorized user) until acted on; ignoring
  the message forever is a valid, unremarkable outcome.
- Tracking "who was offered what" in a database table — the offer's
  entire state lives in the Telegram message itself (its buttons and
  their `callback_data`), nothing persists app-side beyond the normal
  `weapon_ownership` row.

## Testing

Manual only, matching this file's convention: `node --check bot.js`,
then a live smoke test — knock someone holding a real weapon down to
0 health via `/kick`, confirm the buttons appear only when they hold a
weapon, confirm a non-attacker's click is rejected with the alert and
doesn't change the message, confirm "Отобрать" transfers ownership and
`/me`'s weapon display updates for both parties, confirm "Оставить"
leaves ownership unchanged, and confirm buttons disappear after either
choice (a second click on the same message is impossible once the
keyboard is cleared).
