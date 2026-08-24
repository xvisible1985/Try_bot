# Item Transfer (/give) Design

**Repo:** tg-bot only (`bot.js`). No troll-bot changes.

**Goal:** Let one warrior send another warrior a health/energy elixir or a held weapon, with the receiver's explicit consent.

## Command

```
/give @username
/give   (in reply to the recipient's message)
```

Target resolution mirrors `/kick`'s existing logic exactly (same two branches, duplicated rather than shared — consistent with how this file already repeats small resolution snippets per command):

```js
let target = null;
if (msg.reply_to_message && msg.reply_to_message.from) {
  target = { id: msg.reply_to_message.from.id, username: msg.reply_to_message.from.username, firstName: msg.reply_to_message.from.first_name };
} else if (match[1]) {
  const handle = match[1].replace(/^@/, '');
  try {
    const chat = await bot.getChat('@' + handle);
    target = { id: chat.id, username: chat.username, firstName: chat.first_name };
  } catch {}
}
```

Not scoped to `ARENA_CHAT_ID` — usable in any chat, same as `/restore`/`/recharge`/`/me`.

`actorLabel` and `targetLabel` both follow the standard pattern used everywhere else in this file: `username ? '@' + username : firstName` (for the target, `target.firstName`; if the offer needs to re-derive a label from a bare user id later — e.g. the Stage 2 message built from callback_data alone — fall back to the `known_users` lookup pattern used by `/find`/`/warriors`: `username ? '@'+username : first_name`, else `игрок ${id}`).

## Pre-checks (before showing anything)

Run in this order, first failure wins:

1. Target resolved → else "Укажи @юзернейм или ответь на сообщение того, кому хочешь передать предмет."
2. `target.id !== msg.from.id` → else "Себе что ли? 🤔"
3. `isWarrior(msg.from.id)` → else "Сначала стань воином: /warrior"
4. `isWarrior(target.id)` → else "<target label> ещё не воин — нечего ему передавать."
5. Sender has ≥1 elixir of either kind OR ≥1 held weapon (`getWeaponsFor('human', msg.from.id)`) → else "Нечего передать — глянь /inventory."

## Stage 1 — item picker (sender only)

Bot sends one message to the chat, addressed implicitly (only the sender's clicks are honored):

```
${actorLabel}, что передать <targetLabel>?
```

with one inline button per available item:

| Item | Button label | callback_data |
|---|---|---|
| Health elixir (if count > 0) | `🧪❤️ Эликсир здоровья ×N` | `gv_i:<senderId>:<targetId>:elixir:health` |
| Energy elixir (if count > 0) | `🧪⚡ Эликсир энергии ×N` | `gv_i:<senderId>:<targetId>:elixir:energy` |
| Each held weapon | `${def.emoji} ${def.name}` | `gv_i:<senderId>:<targetId>:weapon:<weaponKey>` |

`callback_query` handler for `gv_i:` prefix:
- Reject (`answerCallbackQuery` with alert "Это не твоё предложение") if `query.from.id !== senderId`.
- Re-verify live availability (elixir count > 0 / weapon still owned by sender) — if gone, edit message to "Этого у тебя уже нет." and stop.
- Edit the message (remove keyboard) to: `${actorLabel} предлагает <targetLabel> ${itemLabel}. Ожидание ответа...`
- Send a **new** message addressed to the receiver (Stage 2, below).

## Stage 2 — accept/decline (receiver only)

New message:

```
🎁 ${actorLabel} хочет передать тебе ${itemLabel}, ${targetLabel}. Принимаешь?
```

Buttons: `Принять` / `Отклонить`, callback_data:
- `gv_y:<senderId>:<targetId>:<itemType>:<expiresAt>`
- `gv_n:<senderId>:<targetId>:<itemType>:<expiresAt>`

where `itemType` is `elixir:health` / `elixir:energy` / `weapon:<key>`, and `expiresAt` is a unix timestamp set to `now + 300` (5 minutes) when Stage 1 built this message.

`callback_query` handler:
- Reject (alert "Это предложение не тебе") if `query.from.id !== targetId`.
- `gv_n` (decline): edit message to "Отклонено — предмет остался у ${actorLabel}." Done, nothing else changes.
- `gv_y` (accept):
  - If `now > expiresAt` → edit to "Предложение просрочено." Stop. (Lazy expiry check, same idiom as `hidden_until`/mute/knife-`expires_at` checks elsewhere in this file — no timer needed.)
  - Re-verify and atomically transfer, exactly at click time:
    - **Elixir:** `UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs > 0` (or `energy_elixirs`) — if 0 rows affected, item's gone, edit "У отправителя это уже кончилось." and stop. On success, `UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?` for the receiver (`ensureStatsRow` first, same as every other `pvp_stats` write).
    - **Weapon:** `UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? AND (expires_at IS NULL OR expires_at > strftime('%s','now'))` (receiver id/username, weapon key, sender id as the guard, same expiry filter as `getWeaponsFor`) — if 0 rows affected, "Этого оружия у отправителя уже нет." and stop. `expires_at` is untouched by this UPDATE, so the knife's 3-hour decay clock carries over unchanged.
  - On success, edit message to: `✅ ${actorLabel} передал(а) ${itemLabel} игроку ${targetLabel}!`

No new DB table — same stateless-callback-data pattern as the existing knockout-steal-buttons.

## Item label text

- `elixir:health` → `🧪❤️ эликсир здоровья`
- `elixir:energy` → `🧪⚡ эликсир энергии`
- `weapon:<key>` → `${def.emoji} ${def.accusative}` (e.g. "🔪 ржавый нож")

## /help

Add one line near the existing `/inventory`/`/restore`/`/recharge` block:

```
/give @username — передать эликсир или оружие другому воину (с его подтверждением)
```

## Out of scope

- No cooldown or energy cost on `/give` itself.
- No cap on accumulated elixirs.
- No troll-bot changes (troll-bot has no elixirs/weapon-ownership UI of its own beyond its independent crit-steal).
- No support for transferring a *dropped* (unclaimed, lying-in-chat) weapon — only weapons currently held by the sender (`owner_type = 'human'`).
