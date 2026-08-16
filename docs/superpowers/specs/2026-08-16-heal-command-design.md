# `/heal` command — design

## Purpose

Add an admin-only `/heal` command that clears a patient's injury (arm/leg/
head, from the existing `injuries` table) and any active scissors bleed
(`user_health.bleed_until`/`bleed_chat_id`), in one shot. Health points and
an active "драка" mute are untouched — those are a separate mechanic
(health regen ticks on its own; mute expires on its own timer) and stay
out of scope here.

## Design

Reuses two existing helpers verbatim, matching the established `/cure`
admin-command pattern (`bot.js:1438`) exactly:

- `isAdmin(msg)` (`bot.js:667`) — creator/administrator only, silent no-op
  otherwise (same as every other admin command in this file).
- `resolveUser(msg)` (`bot.js:662`) — reply-to-message only, no
  `@username` parsing (same as `/cure`); replies "Ответь на сообщение" if
  the command wasn't used as a reply.

```js
bot.onText(/\/heal\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  const injuryRow = db.prepare('SELECT injury_type FROM injuries WHERE user_id = ?').get(user.id);
  const bleedRow = db.prepare('SELECT bleed_until FROM user_health WHERE user_id = ?').get(user.id);
  const wasBleeding = bleedRow && bleedRow.bleed_until && bleedRow.bleed_until * 1000 > Date.now();

  if (!injuryRow && !wasBleeding) {
    return bot.sendMessage(msg.chat.id, `${user.username} и так здоров, лечить нечего`, threadOpts(msg));
  }

  db.prepare('DELETE FROM injuries WHERE user_id = ?').run(user.id);
  db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(user.id);

  const healed = [injuryRow && 'травма', wasBleeding && 'кровотечение'].filter(Boolean).join(' и ');
  bot.sendMessage(msg.chat.id, `${user.username} вылечен: ${healed}`, threadOpts(msg));
});
```

**Placement:** right after the existing `/cure` handler (`bot.js:1438-1451`)
— same admin-command neighborhood, same style.

**Why clear both unconditionally rather than checking each independently
first:** the `DELETE`/`UPDATE` are both no-ops if the respective condition
was already false (`DELETE` affects 0 rows if no injury row exists;
`UPDATE ... SET bleed_until = NULL` is harmless if it's already NULL) — so
running both is simpler than branching, and the early "nothing to heal"
return already covers the only case that needs different messaging.

**Message wording:** reports exactly what was healed (`травма`,
`кровотечение`, or `травма и кровотечение`) rather than a generic
"вылечен", so the admin can see what was actually wrong — matching
`/cure`'s own precedent of a specific confirmation message.

## Out of scope

- Health points / active `драка` mute — untouched, separate mechanic.
- `@username` targeting — `resolveUser` doesn't support it and neither
  does `/cure`; reply-only is the established convention for admin
  patient-targeting commands in this file.
- troll-bot — this command lives entirely in tg-bot, since it's the repo
  that owns both `injuries` and `user_health`.

## Testing

Manual only, same convention as every other command in this file:
`node --check bot.js`, then live smoke test — reply `/heal` to an injured
and/or bleeding user as an admin, confirm the injury/bleed clear and the
confirmation message names the right condition(s); try it against a
healthy user and confirm the "нечего лечить" message; try it as a
non-admin and confirm silent no-op.
