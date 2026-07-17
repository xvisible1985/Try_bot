# DedoVirus.2026 Patient Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal "patient card" (`/patient`) and a self-service cure attempt (`/immune`, gated by an "energy" resource earned from chatting) to the already-shipped DedoVirus.2026 chat game feature.

**Architecture:** Same single-file `bot.js` convention as the rest of this feature. One new column (`energy`, migrated the same way `reached_stage2` was), one small addition to the existing message-count increment block, and two new self-contained commands (`/patient`, `/immune`) reusing existing helpers (`getVirusRow`, `getDisplayName`, `resolveUser`, `isAdmin`, `getActiveVirusProcedureTypes`, `VIRUS_PROCEDURE_ICONS`, `threadOpts`).

**Tech Stack:** Node.js, `better-sqlite3`. Same "no test framework, static verification + manual smoke test" approach as the rest of this project.

Full design: `docs/superpowers/specs/2026-07-16-dedovirus-2026-design.md`, section "Addendum: patient card and self-cure via `/immune`".

**IMPORTANT for every task below — do NOT run `node bot.js` locally.** The project's `.env` `BOT_TOKEN` is shared with the production bot (running via PM2 on a separate server); a second local long-polling instance against the same token causes Telegram API conflicts for production. Static verification (`node --check`, code reading, hand-tracing) only — live verification happens in the final deploy/smoke-test step.

---

### Task 1: `energy` column + increment wiring + 100-threshold announcement

**Files:**
- Modify: `bot.js` (three edits, see below)

- [ ] **Step 1: Add the `energy` column to the schema**

Find this exact text in `bot.js`:

```js
  CREATE TABLE IF NOT EXISTS virus_infections (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    stage INTEGER NOT NULL DEFAULT 1,
    is_patient_zero INTEGER DEFAULT 0,
    immune INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    reached_stage2 INTEGER DEFAULT 0,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
try { db.exec('ALTER TABLE virus_infections ADD COLUMN reached_stage2 INTEGER DEFAULT 0'); } catch {};
```

Replace with:

```js
  CREATE TABLE IF NOT EXISTS virus_infections (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    stage INTEGER NOT NULL DEFAULT 1,
    is_patient_zero INTEGER DEFAULT 0,
    immune INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    reached_stage2 INTEGER DEFAULT 0,
    energy INTEGER DEFAULT 0,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
try { db.exec('ALTER TABLE virus_infections ADD COLUMN reached_stage2 INTEGER DEFAULT 0'); } catch {};
try { db.exec('ALTER TABLE virus_infections ADD COLUMN energy INTEGER DEFAULT 0'); } catch {};
```

- [ ] **Step 2: Increment energy alongside message_count, announce at 100**

Find this exact text in `bot.js`:

```js
      const newCount = virusRow.message_count + 1;
      db.prepare('UPDATE virus_infections SET message_count = ? WHERE user_id = ?').run(newCount, msg.from.id);

      const every = VIRUS_COUGH_EVERY[virusRow.stage] || VIRUS_COUGH_EVERY[3];
```

Replace with:

```js
      const newCount = virusRow.message_count + 1;
      const newEnergy = Math.min(100, virusRow.energy + 1);
      db.prepare('UPDATE virus_infections SET message_count = ?, energy = ? WHERE user_id = ?').run(newCount, newEnergy, msg.from.id);
      if (newEnergy === 100 && virusRow.energy < 100) {
        bot.sendMessage(msg.chat.id, `⚡ ${virusNick} накопил(а) 100 энергии — теперь можно попробовать /immune!`, threadOpts(msg)).catch(() => {});
      }

      const every = VIRUS_COUGH_EVERY[virusRow.stage] || VIRUS_COUGH_EVERY[3];
```

(The `virusRow.energy < 100` guard ensures the announcement fires exactly once per 100-energy "cycle" — only on the message that pushes energy from below 100 up to the 100 cap, not on every subsequent message while it stays capped at 100. `virusNick` is already in scope here, computed at the top of the same `bot.on('message', ...)` handler.)

- [ ] **Step 3: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual verification (static only)**

1. Confirm the migration follows the exact same `try { db.exec('ALTER TABLE ... ADD COLUMN ...'); } catch {};` shape as the pre-existing `reached_stage2` migration right above it.
2. Confirm `getVirusRow` (`SELECT * FROM virus_infections WHERE user_id = ?`) will automatically include the new `energy` column once this migration has run — no changes needed to that helper.
3. Hand-trace: a user with `energy = 99` sends a message → `newEnergy = min(100, 100) = 100`, `virusRow.energy(99) < 100` → announcement fires. Next message from the same user (now `virusRow.energy = 100`): `newEnergy = min(100, 101) = 100`, `virusRow.energy(100) < 100` is `false` → no repeat announcement. Confirms "fires once per crossing, not every message while capped."
4. Confirm this increment happens for patient zero too (the surrounding `if (virusRow && !virusRow.immune)` gate doesn't exclude `is_patient_zero`), matching the design decision that patient zero also accumulates energy (even though it won't help them later).

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat(virus): add energy tracking with a 100-threshold chat announcement"
```

---

### Task 2: `/patient` command

**Files:**
- Modify: `bot.js` (insert right before `// --- List animals ---`)

- [ ] **Step 1: Add the command**

Find this exact text in `bot.js` (unique section header, currently immediately preceded by `/endvirus`):

```js
// --- List animals ---
```

Replace with:

```js
bot.onText(/\/patient\b/, async (msg) => {
  let targetId = msg.from.id;
  let targetNick = await getDisplayName(msg);
  if (msg.reply_to_message && await isAdmin(msg)) {
    const user = await resolveUser(msg);
    targetId = user.id;
    targetNick = user.username;
  }

  const row = getVirusRow(targetId);
  if (!row) return bot.sendMessage(msg.chat.id, `${targetNick} здоров`, threadOpts(msg));
  if (row.immune) return bot.sendMessage(msg.chat.id, `${targetNick} имеет иммунитет к DedoVirus.2026`, threadOpts(msg));

  const infectedDate = new Date(row.created_at * 1000).toLocaleDateString('ru-RU');
  const temp = (36.6 + row.stage * 0.6 + (Math.random() * 0.6 - 0.3)).toFixed(1);
  const procs = getActiveVirusProcedureTypes(targetId);
  const procText = procs.length ? procs.map(p => `${VIRUS_PROCEDURE_ICONS[p] || '💉'} ${p}`).join(', ') : 'нет';
  const stageLabel = row.is_patient_zero ? 'нулевой пациент' : `${row.stage}`;
  const energyLine = `⚡ Энергия: ${row.energy}/100${row.is_patient_zero ? ' (иммунитету это не поможет)' : ''}`;

  const lines = [
    `🤒 Карточка больного: ${targetNick}`,
    `📅 Заражён: ${infectedDate}`,
    `🧬 Стадия: ${stageLabel}`,
    `🌡 Температура: ${temp}°C`,
    `💊 Процедуры: ${procText}`,
    energyLine,
  ];
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg));
});

// --- List animals ---
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual verification (static only)**

1. Confirm `getDisplayName`, `isAdmin`, `resolveUser`, `getVirusRow`, `getActiveVirusProcedureTypes`, `VIRUS_PROCEDURE_ICONS`, `threadOpts` are all pre-existing — no new helpers needed.
2. Hand-trace three callers: (a) non-admin, no reply → shows own card via `getDisplayName`; (b) non-admin WITH a reply → `await isAdmin(msg)` is `false`, so the `if` block is skipped entirely, still shows own card (reply ignored, matching design); (c) admin WITH a reply → shows the replied-to user's card via `resolveUser`.
3. Hand-trace the three response branches: no row → `"{ник} здоров"`; row with `immune=1` → `"{ник} имеет иммунитет..."`; row with `immune=0` → full 6-line card.
4. Confirm the temperature formula (`36.6 + row.stage * 0.6 + jitter`) produces a plausible one-decimal Celsius value for stage 1/2/3 (e.g. stage 1 ≈ 36.9-37.5, stage 3 ≈ 38.1-38.7) and that `.toFixed(1)` always yields exactly one decimal digit.
5. Confirm `new Date(row.created_at * 1000).toLocaleDateString('ru-RU')` produces a `DD.MM.YYYY`-style string (Node's built-in `Intl` support handles the `ru-RU` locale without extra dependencies).
6. Confirm the energy line's patient-zero suffix only appears when `row.is_patient_zero` is truthy.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat(virus): add /patient command showing a personal status card"
```

---

### Task 3: `/immune` command

**Files:**
- Modify: `bot.js` (insert right before `// --- List animals ---`)

- [ ] **Step 1: Add the command**

Find this exact text in `bot.js` (unique section header, by now immediately preceded by Task 2's `/patient` block):

```js
// --- List animals ---
```

Replace with:

```js
bot.onText(/\/immune\b/, async (msg) => {
  const virusRow = getVirusRow(msg.from.id);
  const nick = await getDisplayName(msg);
  if (!virusRow || virusRow.immune) return bot.sendMessage(msg.chat.id, 'Ты не болен', threadOpts(msg));
  if (virusRow.energy < 100) return bot.sendMessage(msg.chat.id, `Недостаточно энергии (${virusRow.energy}/100)`, threadOpts(msg));

  db.prepare('UPDATE virus_infections SET energy = 0 WHERE user_id = ?').run(msg.from.id);

  if (virusRow.is_patient_zero) {
    return bot.sendMessage(msg.chat.id, `🦠 ${nick}: иммунная система бессильна против нулевого пациента`, threadOpts(msg));
  }

  if (Math.random() < 0.5) {
    if (virusRow.stage <= 1) {
      db.prepare('UPDATE virus_infections SET immune = 1 WHERE user_id = ?').run(msg.from.id);
      db.prepare('DELETE FROM virus_procedures WHERE user_id = ?').run(msg.from.id);
      bot.sendMessage(msg.chat.id, `🛡️ ${nick}: иммунная система победила! Полное выздоровление, получен иммунитет!`, threadOpts(msg));
    } else {
      const newStage = virusRow.stage - 1;
      db.prepare('UPDATE virus_infections SET stage = ? WHERE user_id = ?').run(newStage, msg.from.id);
      bot.sendMessage(msg.chat.id, `🛡️ ${nick}: иммунная система откатила болезнь (стадия ${virusRow.stage}→${newStage})`, threadOpts(msg));
    }
  } else {
    bot.sendMessage(msg.chat.id, `🦠 ${nick}: иммунная система не справилась, энергия потрачена впустую`, threadOpts(msg));
  }
});

// --- List animals ---
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual verification (static only)**

1. Confirm `getVirusRow`, `getDisplayName`, `db`, `threadOpts` are all pre-existing.
2. Hand-trace guard order: no row or already immune → `"Ты не болен"`, no energy reset. Row exists, not immune, `energy < 100` → `"Недостаточно энергии (N/100)"`, no energy reset. Only past BOTH guards does `energy` get reset to 0 — confirm the reset line runs unconditionally once reached (regardless of what happens next), matching "always resets to 0 regardless of outcome."
3. Confirm patient zero's branch returns immediately after the energy reset, before the 50% roll — so patient zero never gets a stage-change or immunity, ever, via this command, matching the design decision.
4. Confirm the stage-1-success path sets `immune = 1` and deletes `virus_procedures`, mirroring exactly what the automatic cough-roll's `cured` branch and the admin `/cure` command already do (same two SQL statements) — for consistency, the resulting DB state must be indistinguishable from those other two cure paths.
5. Confirm the stage-2/3-success path only updates `stage` (not `message_count` or `reached_stage2`) — unlike the automatic cough-roll's `improve` branch, which also resets `message_count` to 0. This is an intentional, minor difference: `/immune` doesn't interact with the cough-cadence counter at all, since it's a separate, player-initiated action, not a cough event. (Not a bug — flag it only if something in your reading suggests otherwise, but this is expected: cough cadence is unrelated to when a player chooses to spend their energy.)
6. Confirm failure path sends the "не справилась" message but does NOT change `stage`, `immune`, or anything else beyond the unconditional energy reset already applied.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat(virus): add /immune command for a 50/50 self-cure attempt at 100 energy"
```

---

### Task 4: Deploy and full end-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Deploy on the prod server**

```bash
cd /root/Try_bot
git pull origin main
npm ci --production
pm2 restart tg-bot --update-env
pm2 logs tg-bot --lines 20 --nostream
```

Expected: `Бот запущен...` with no stack traces or `unhandledRejection` entries.

- [ ] **Step 3: Full manual playthrough in the real chat**

1. `/patient` as a healthy user (never infected) — confirm `"{ник} здоров"`.
2. Get infected (via `/0patient`, cough-spread, or reaction-spread from the existing feature), then `/patient` again — confirm the full card renders with a plausible date/temperature/stage/procedures/energy line.
3. Chat normally and watch energy climb (visible via repeated `/patient` calls) until it announces reaching 100 unprompted.
4. `/immune` below 100 energy (if testable) or right after reaching 100 — confirm either the "Недостаточно энергии" message or a 50/50 outcome message, and that `/patient` afterward shows `Энергия: 0/100`.
5. If `/immune` succeeds at stage 1 — confirm the person shows up as immune via `/patient` and in `/epidemic`'s "С иммунитетом" list afterward.
6. If `/immune` succeeds at stage 2/3 — confirm `/patient` shows the reduced stage.
7. Try `/patient` as a non-admin replying to someone else's message — confirm it shows the CALLER's own card, not the reply target's.
8. Try `/patient` as an admin replying to someone else's message — confirm it shows the REPLY TARGET's card.

- [ ] **Step 4: Report back**

No commit needed — final live verification only.

---

## Self-Review Notes

- **Spec coverage:** every point in the design addendum maps to a task — energy column + increment + announcement (Task 1), `/patient` card (Task 2), `/immune` (Task 3).
- **Placeholder scan:** no TBDs; every step has complete code or an exact command with expected output.
- **Type/name consistency:** `getVirusRow`, `getDisplayName`, `resolveUser`, `isAdmin`, `getActiveVirusProcedureTypes`, `VIRUS_PROCEDURE_ICONS`, `threadOpts`, `virusNick` are all pre-existing identifiers referenced with their established names/signatures — nothing redefined.
- **Regression risk:** Task 1's edit sits inside the existing cough-handling gate but only ADDS a second `UPDATE` column and one new conditional `sendMessage` — the pre-existing `message_count`/cough-cadence logic immediately below is untouched. Tasks 2 and 3 are net-new, self-contained command handlers with no interaction with existing commands beyond reading shared helpers/tables.
