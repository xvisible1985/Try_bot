# Ежедневная выплата воинам Design

**Repo:** tg-bot only (`bot.js`). No troll-bot changes.

**Goal:** Once a day, at 08:00 server time, every warrior gets +10 coins, announced once in the arena chat. First piece of a larger "economy" feature (daily payout → shop framework/elixirs → weapon shop/knife rework → clothing); the other three ship as separate, later specs.

## Schema

One new column on the existing `health_regen_state` singleton row — same table, same idiom already used for the 4am full-health-restore's own "only once per calendar day" guard:

```js
for (const [column, def] of [['last_daily_payout_date', 'TEXT']]) {
  try { db.exec(`ALTER TABLE health_regen_state ADD COLUMN ${column} ${def}`); } catch {}
}
```

## Trigger

Inside the existing `healthRegenTick` (already runs every 10 minutes and already has an identical `hour === 4 && ... !== today` check for the full-health-restore), add a second, independent check for hour 8:

```js
if (hour === 8 && regenState.last_daily_payout_date !== today) {
  db.exec('UPDATE pvp_stats SET coins = coins + 10 WHERE is_warrior = 1');
  db.prepare('UPDATE health_regen_state SET last_daily_payout_date = ? WHERE id = 1').run(today);
  bot.sendMessage(ARENA_CHAT_ID, '💰 Всем воинам начислено +10 монет за день!').catch(err => console.error('daily payout announcement failed:', err.message));
}
```

Placed right after the existing 4am block, reusing the same `today`/`regenState`/`hour` variables already computed there — no new query needed.

## Out of scope

- No pro-ration for warriors who register mid-day — they simply receive their first payout on the next occurrence of 08:00, same as everyone else, no special-casing.
- No opt-out, no claim command — fully automatic, matches the 4am full-restore's own unconditional style.
- Shop, elixir/weapon purchases, clothing — separate, later specs.
