# DedoVirus.2026 — design

## Purpose

A fun chat "epidemic" event, independent from the existing `/dimon` status. An
admin designates a patient zero; the virus spreads probabilistically through
the chat via "coughs," carriers progress/regress through 3 stages, and
admin-doctors can apply procedures to boost recovery odds (at the cost of a
side effect).

## Data model

```sql
CREATE TABLE virus_infections (
  user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  username TEXT,
  stage INTEGER NOT NULL DEFAULT 1,     -- 1/2/3. Patient zero: fixed at 3, never changes.
  is_patient_zero INTEGER DEFAULT 0,
  immune INTEGER DEFAULT 0,             -- cured from stage 1 -> full recovery, can't be reinfected
  message_count INTEGER DEFAULT 0,      -- counts this user's own text messages, for cough cadence
  added_by INTEGER,
  added_by_name TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE virus_procedures (
  user_id INTEGER NOT NULL,
  procedure_type TEXT NOT NULL,         -- 'ukol' | 'klizma' | 'topor'
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, procedure_type)
);
```

Immune users stay in `virus_infections` (immune=1, stage irrelevant) purely so
the infection-roll step can recognize and skip them. Re-applying a procedure
already active on a user overwrites that same row (refreshes `expires_at`,
does not stack with itself); a *different* procedure type is a separate row,
so its bonus stacks independently.

In-memory only (not persisted, resets on bot restart — acceptable for a game
mechanic): `recentMessages: Map<chatId, Array<{userId, username}>>`, capped to
the last 3 entries per chat. Updated after processing each message.

## Constants (tunable, top of virus section)

```js
const COUGH_CHANCE = 0.30;
const INFECT_CHANCE = 0.25;
const BASE_IMPROVE_CHANCE = 0.10;
const WORSEN_CHANCE = 0.15;
const SIDE_EFFECT_CHANCE = 0.20;

const COUGH_EVERY = { 1: 7, 2: 5, 3: 3 }; // messages between cough rolls, by stage; patient zero uses stage 3's cadence

const PROCEDURES = {
  ukol:   { bonus: 0.02, durationMs: 6  * 60 * 60 * 1000 },
  klizma: { bonus: 0.03, durationMs: 2  * 24 * 60 * 60 * 1000 },
  topor:  { bonus: 0.05, durationMs: 1  * 24 * 60 * 60 * 1000 },
};
```

## Core mechanic

On every text message from a user present in `virus_infections` (stage set,
not just immune) that isn't a command:

1. Increment `message_count`. If it has reached a multiple of
   `COUGH_EVERY[stage]` (patient zero → `COUGH_EVERY[3]`), roll `COUGH_CHANCE`.
2. **On a successful cough:**
   - Delete the original message; repost with an appended/replaced phrase
     depending on stage (own phrase lists, independent of `dimon`'s):
     - Stage 1: append `*кхе-кхе*`.
     - Stage 2: append one of an "old-man" phrase set (separate list from
       `dimon`'s, same flavor).
     - Stage 3: same as stage 2, except each time there's also a 5% roll
       (mirroring `dimon`'s existing pattern) to use a gag phrase instead of
       the normal old-man one — описался/пукнул/etc, DedoVirus's own list,
       not shared with `dimon`'s.
   - Look at `recentMessages[chatId]` (last 3 entries, any authors, can
     repeat). For each: if that author is not already in `virus_infections`
     (neither infected nor immune) and not patient zero, roll
     `INFECT_CHANCE`. On success, insert `stage=1` and post
     `🦠 {ник} заразился(-ась)!`.
   - Skip this step for patient zero (never changes stage): otherwise, roll
     stage change. `improveChance = BASE_IMPROVE_CHANCE + sum(bonus of that
     user's unexpired virus_procedures rows)`. `r = Math.random()`:
     - `r < improveChance` → improve: stage - 1, or if already stage 1 → fully
       cured (`immune = 1`, stage cleared/removed from active tracking; also
       delete that user's `virus_procedures` rows, same cleanup `/cure`
       does). Post `💊 {ник} идёт на поправку (стадия X→Y)` or
       `✅ {ник} полностью выздоровел и получил иммунитет!`.
     - else if `r < improveChance + WORSEN_CHANCE` → worsen: stage + 1
       (capped at 3). Post `🤒 {ник} стало хуже (стадия X→Y)`.
     - else: no change.
3. Append the current message to `recentMessages[chatId]` (after processing,
   so it's available for the next cough).

## Procedures (admin/doctor-only, reply to the target's message)

- `/ukol` — upserts `virus_procedures` row `('ukol', now + 6h)`. While active:
  `SIDE_EFFECT_CHANCE` per message to append a pain-related phrase (own
  list: "схватился за попу", "почесал место укола", etc.) to that user's
  messages.
- `/klizma` — `('klizma', now + 2d)`. While active: `SIDE_EFFECT_CHANCE` per
  message to append a gas-related phrase.
- `/topor` — `('topor', now + 24h)`. While active: `SIDE_EFFECT_CHANCE` per
  message to *replace* the entire message text with a nonsense phrase (own
  list), instead of appending.

All three require `isAdmin(msg)` and a `reply_to_message` (same pattern as
`/mute`, `/dimon`, etc.). Side effects are separate from the cough mechanic —
they check independently on every message from a user with active procedure
rows, regardless of whether a cough also fired that message.

## Admin commands

- `/0patient` (reply, admin-only) — insert/replace
  `virus_infections(stage=3, is_patient_zero=1, immune=0)` for the target.
  Reply: `☣️ {ник} — нулевой пациент эпидемии DedoVirus.2026!`
- `/epidemic` (admin-only) — lists everyone currently in `virus_infections`
  with stage/patient-zero marker and any active procedures with remaining
  time, e.g.:
  ```
  ☣️ DedoVirus.2026
  💀 @vasya — нулевой пациент
  🤧 @petya — стадия 1
  🧟 @kolya — стадия 2 (💉 укол ещё 3ч)
  🤢 @dima — стадия 3
  ```
  If nobody is infected: `Эпидемии нет`.
- `/cure` (reply, admin-only) — deletes the target's `virus_infections` row
  (and their `virus_procedures` rows). Refuses on patient zero:
  `Нулевого пациента вылечить нельзя, используй /endvirus`.
- `/endvirus` (admin-only) — deletes all rows from both `virus_infections`
  and `virus_procedures`. Confirms in chat, e.g. `Эпидемия DedoVirus.2026
  закончена`.
- **Hourly broadcast** — a `setInterval` (60 min) that, if
  `virus_infections` has any rows, posts the same listing as `/epidemic`
  unprompted to the chat (using the `chat_id` stored on those rows). Silent
  if the table is empty.

## Out of scope / notes

- Single implicit chat, following this bot's existing convention (tables
  store `chat_id` but the bot doesn't currently scope queries by it anywhere
  else either — not introducing new multi-chat handling here).
- No interaction with the existing `/dimon` status — a user can in principle
  hold both statuses; each applies its own logic independently since they're
  separate tables and separate code paths.
- `recentMessages` resets on bot restart; a restart briefly makes new coughs
  unable to find infection targets until 3 fresh messages accumulate. Judged
  acceptable for a game mechanic, consistent with other in-memory-only
  trackers already in this file (e.g. `fishingTracker`).
