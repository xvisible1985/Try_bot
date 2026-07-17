# DedoVirus.2026 Mutation & Sex-Zombie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second virus strain ("beta," a mutation of the existing "alpha") to the already-shipped DedoVirus.2026 feature. Mutation occurs when a stage-3 alpha cougher's infection attempt targets someone who already has an alpha row (active or immune) — 15% chance of overwriting them with a fresh beta stage-1 infection instead of the normal skip. Beta can progress beyond stage 3 to a terminal stage-4 "sex-zombie" status.

**Architecture:** Same single-file `bot.js` convention. One new column (`strain`, migrated the same way `reached_stage2`/`energy` were), a `maxStage` parameter threaded through the existing `rollVirusStageChange`, one new branch inside the existing cough-suffix selection, one new branch inside the existing infection-spread loop, and an emoji-scheme rewrite in `formatVirusList()`.

**Tech Stack:** Node.js, `better-sqlite3`. Same "no test framework, throwaway assert script for pure logic + static verification" approach as the rest of this project.

Full design: `docs/superpowers/specs/2026-07-16-dedovirus-2026-design.md`, section "Addendum: strain mutation and the sex-zombie terminal stage".

**IMPORTANT for every task below — do NOT run `node bot.js` locally.** The project's `.env` `BOT_TOKEN` is shared with the production bot (running via PM2 on a separate server); a second local long-polling instance against the same token causes Telegram API conflicts for production. Static verification (`node --check`, code reading, hand-tracing, throwaway assert scripts) only — live verification happens in the final deploy/smoke-test task.

---

### Task 1: `strain` column + constants

**Files:**
- Modify: `bot.js` (two insertion points, see below)

- [ ] **Step 1: Add the `strain` column to the schema**

Find this exact text in `bot.js`:

```js
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

Replace with:

```js
    reached_stage2 INTEGER DEFAULT 0,
    energy INTEGER DEFAULT 0,
    strain TEXT NOT NULL DEFAULT 'alpha',
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
try { db.exec('ALTER TABLE virus_infections ADD COLUMN reached_stage2 INTEGER DEFAULT 0'); } catch {};
try { db.exec('ALTER TABLE virus_infections ADD COLUMN energy INTEGER DEFAULT 0'); } catch {};
try { db.exec("ALTER TABLE virus_infections ADD COLUMN strain TEXT NOT NULL DEFAULT 'alpha'"); } catch {};
```

(Every existing row — and every future INSERT that doesn't explicitly mention `strain`, i.e. `/0patient`, the normal cough-spread infection INSERT, and the reaction-spread infection INSERT — automatically gets `'alpha'` via the column default. Only the new mutation path, added in a later task, explicitly inserts `'beta'`.)

- [ ] **Step 2: Add mutation/strain constants**

Find this exact text in `bot.js`:

```js
const VIRUS_COUGH_CONTAINED_PHRASES = [
  '*прикрыл рот*', '*успел прикрыться платком*', '*откашлялся в сторону*',
  '*сдержался*', '*обошлось без жертв*',
];
```

Replace with:

```js
const VIRUS_MUTATION_CHANCE = 0.15;
const VIRUS_STRAIN_ICONS = { alpha: '🦠', beta: '👾' };
const VIRUS_ZOMBIE_ICON = '🧟';

const VIRUS_SEXZOMBIE_PHRASES = [
  '*подмигнул всем присутствующим*', '*предложил встретиться после чата*',
  '*начал флиртовать без разбора*', '*облизнулся и подмигнул*',
  '*сделал комплимент фигуре собеседника*',
];

const VIRUS_COUGH_CONTAINED_PHRASES = [
  '*прикрыл рот*', '*успел прикрыться платком*', '*откашлялся в сторону*',
  '*сдержался*', '*обошлось без жертв*',
];
```

- [ ] **Step 3: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual verification (static only)**

1. Confirm the migration follows the exact same `try { db.exec('ALTER TABLE ... ADD COLUMN ...'); } catch {};` shape as `reached_stage2`/`energy`.
2. Confirm `getVirusRow` (`SELECT *`) will automatically include `strain` once the migration runs.
3. Confirm the 3 pre-existing INSERTs into `virus_infections` (`/0patient`, cough-spread, reaction-spread — none of them list `strain` in their column list) will all get `'alpha'` via the schema default — grep for `INSERT OR REPLACE INTO virus_infections` to confirm none of the 3 need editing.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat(virus): add strain column and mutation/sex-zombie constants"
```

---

### Task 2: `rollVirusStageChange` gains a `maxStage` parameter

**Files:**
- Modify: `bot.js` (one function)

- [ ] **Step 1: Write a throwaway verification script for the updated cap logic, run it BEFORE trusting the real change**

Create `C:\Users\123\AppData\Local\Temp\claude\c--Users-123-Projects-tg-bot\fb13a5cf-d68f-43bd-88e1-98535e0cd127\scratchpad\virus-maxstage-check.js`:

```js
const assert = require('assert');

function rollVirusStageChange(currentStage, improveChance, everReachedStage2, maxStage, r) {
  const WORSEN_CHANCE = 0.25;
  const canImprove = currentStage > 1 || everReachedStage2;
  if (canImprove && r < improveChance) {
    if (currentStage <= 1) return { type: 'cured' };
    return { type: 'improve', newStage: currentStage - 1 };
  }
  const worsenFloor = canImprove ? improveChance : 0;
  if (r < worsenFloor + WORSEN_CHANCE) {
    return { type: 'worsen', newStage: Math.min(maxStage, currentStage + 1) };
  }
  return { type: 'none' };
}

// alpha (maxStage=3): worsening from stage 3 stays capped at 3
assert.deepStrictEqual(rollVirusStageChange(3, 0.10, true, 3, 0.20), { type: 'worsen', newStage: 3 });

// beta (maxStage=4): worsening from stage 3 can now reach 4
assert.deepStrictEqual(rollVirusStageChange(3, 0.10, true, 4, 0.20), { type: 'worsen', newStage: 4 });

// beta worsening from stage 2 still only reaches 3, not 4 in one jump
assert.deepStrictEqual(rollVirusStageChange(2, 0.10, true, 4, 0.20), { type: 'worsen', newStage: 3 });

// stage 1 behavior unaffected by maxStage (improve/cure logic doesn't reference it)
assert.deepStrictEqual(rollVirusStageChange(1, 0.10, false, 3, 0.05), { type: 'worsen', newStage: 2 });
assert.deepStrictEqual(rollVirusStageChange(1, 0.10, true, 3, 0.05), { type: 'cured' });

console.log('OK');
```

Run: `node "C:\Users\123\AppData\Local\Temp\claude\c--Users-123-Projects-tg-bot\fb13a5cf-d68f-43bd-88e1-98535e0cd127\scratchpad\virus-maxstage-check.js"`
Expected: `OK`

- [ ] **Step 2: Update the real function**

Find this exact text in `bot.js`:

```js
function rollVirusStageChange(currentStage, improveChance, everReachedStage2, r = Math.random()) {
  const canImprove = currentStage > 1 || everReachedStage2;
  if (canImprove && r < improveChance) {
    if (currentStage <= 1) return { type: 'cured' };
    return { type: 'improve', newStage: currentStage - 1 };
  }
  const worsenFloor = canImprove ? improveChance : 0;
  if (r < worsenFloor + WORSEN_CHANCE) {
    return { type: 'worsen', newStage: Math.min(3, currentStage + 1) };
  }
  return { type: 'none' };
}
```

Replace with:

```js
function rollVirusStageChange(currentStage, improveChance, everReachedStage2, maxStage, r = Math.random()) {
  const canImprove = currentStage > 1 || everReachedStage2;
  if (canImprove && r < improveChance) {
    if (currentStage <= 1) return { type: 'cured' };
    return { type: 'improve', newStage: currentStage - 1 };
  }
  const worsenFloor = canImprove ? improveChance : 0;
  if (r < worsenFloor + WORSEN_CHANCE) {
    return { type: 'worsen', newStage: Math.min(maxStage, currentStage + 1) };
  }
  return { type: 'none' };
}
```

(`maxStage` is a new required parameter inserted before the optional `r`, matching the throwaway script's signature exactly. The only caller of this function — in the cough-handling block — is updated in Task 3, not here; this task only changes the function itself.)

- [ ] **Step 3: Verify the file still parses, then re-run the throwaway script**

Run: `node --check bot.js` — expect no output, exit code 0.
Run again: `node "C:\Users\123\AppData\Local\Temp\claude\c--Users-123-Projects-tg-bot\fb13a5cf-d68f-43bd-88e1-98535e0cd127\scratchpad\virus-maxstage-check.js"` — expect `OK`.

- [ ] **Step 4: Manual verification (static only)**

Grep for every call site of `rollVirusStageChange` in `bot.js` — there should be exactly ONE (in the cough-handling block). It will be broken (wrong argument count) until Task 3 updates it — that's expected and fine; Task 3 fixes the only call site immediately after this task's function signature change. Do NOT update the call site in this task — keep the tasks focused as planned.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat(virus): add maxStage parameter to rollVirusStageChange for beta's stage-4 ceiling"
```

---

### Task 3: Wire up `maxStage`, the sex-zombie exclusion/transformation, and cough-phrase branch

**Files:**
- Modify: `bot.js` (two edits in the same combined message-handling block)

- [ ] **Step 1: Add the sex-zombie phrase branch to cough-suffix selection**

Find this exact text in `bot.js`:

```js
        let suffix;
        if (virusRow.stage === 1) suffix = VIRUS_STAGE1_PHRASE;
        else if (virusRow.stage === 3 && Math.random() < 0.05) suffix = `*${pick(VIRUS_STAGE3_EXTRAS)}*`;
        else suffix = pick(VIRUS_STAGE2_PHRASES);
        if (!massaged) virusText += `\n${suffix}`;
```

Replace with:

```js
        let suffix;
        if (virusRow.strain === 'beta' && virusRow.stage === 4) suffix = pick(VIRUS_SEXZOMBIE_PHRASES);
        else if (virusRow.stage === 1) suffix = VIRUS_STAGE1_PHRASE;
        else if (virusRow.stage === 3 && Math.random() < 0.05) suffix = `*${pick(VIRUS_STAGE3_EXTRAS)}*`;
        else suffix = pick(VIRUS_STAGE2_PHRASES);
        if (!massaged) virusText += `\n${suffix}`;
```

- [ ] **Step 2: Exclude sex-zombies from stage-change rolls, thread `maxStage` through, add the transformation announcement**

Find this exact text in `bot.js`:

```js
        if (!virusRow.is_patient_zero) {
          const improveChance = BASE_IMPROVE_CHANCE + getVirusProcedureBonus(msg.from.id);
          const result = rollVirusStageChange(virusRow.stage, improveChance, !!virusRow.reached_stage2);
          if (result.type === 'cured') {
            db.prepare('UPDATE virus_infections SET immune = 1 WHERE user_id = ?').run(msg.from.id);
            db.prepare('DELETE FROM virus_procedures WHERE user_id = ?').run(msg.from.id);
            bot.sendMessage(msg.chat.id, `✅ ${virusNick} полностью выздоровел и получил иммунитет!`, threadOpts(msg)).catch(() => {});
          } else if (result.type === 'improve') {
            db.prepare('UPDATE virus_infections SET stage = ?, message_count = 0 WHERE user_id = ?').run(result.newStage, msg.from.id);
            bot.sendMessage(msg.chat.id, `💊 ${virusNick} идёт на поправку (стадия ${virusRow.stage}→${result.newStage})`, threadOpts(msg)).catch(() => {});
          } else if (result.type === 'worsen') {
            db.prepare('UPDATE virus_infections SET stage = ?, message_count = 0, reached_stage2 = 1 WHERE user_id = ?').run(result.newStage, msg.from.id);
            bot.sendMessage(msg.chat.id, `🤒 ${virusNick} стало хуже (стадия ${virusRow.stage}→${result.newStage})`, threadOpts(msg)).catch(() => {});
          }
        }
```

Replace with:

```js
        if (!virusRow.is_patient_zero && !(virusRow.strain === 'beta' && virusRow.stage === 4)) {
          const improveChance = BASE_IMPROVE_CHANCE + getVirusProcedureBonus(msg.from.id);
          const maxStage = virusRow.strain === 'beta' ? 4 : 3;
          const result = rollVirusStageChange(virusRow.stage, improveChance, !!virusRow.reached_stage2, maxStage);
          if (result.type === 'cured') {
            db.prepare('UPDATE virus_infections SET immune = 1 WHERE user_id = ?').run(msg.from.id);
            db.prepare('DELETE FROM virus_procedures WHERE user_id = ?').run(msg.from.id);
            bot.sendMessage(msg.chat.id, `✅ ${virusNick} полностью выздоровел и получил иммунитет!`, threadOpts(msg)).catch(() => {});
          } else if (result.type === 'improve') {
            db.prepare('UPDATE virus_infections SET stage = ?, message_count = 0 WHERE user_id = ?').run(result.newStage, msg.from.id);
            bot.sendMessage(msg.chat.id, `💊 ${virusNick} идёт на поправку (стадия ${virusRow.stage}→${result.newStage})`, threadOpts(msg)).catch(() => {});
          } else if (result.type === 'worsen' && result.newStage === 4) {
            db.prepare('UPDATE virus_infections SET stage = 4, message_count = 0, reached_stage2 = 1 WHERE user_id = ?').run(msg.from.id);
            bot.sendMessage(msg.chat.id, `🧟 ${virusNick} превратился(-ась) в секс-зомби! Стал(а) молодым(ой), дерзким(ой) и пристаёт ко всем подряд!`, threadOpts(msg)).catch(() => {});
          } else if (result.type === 'worsen') {
            db.prepare('UPDATE virus_infections SET stage = ?, message_count = 0, reached_stage2 = 1 WHERE user_id = ?').run(result.newStage, msg.from.id);
            bot.sendMessage(msg.chat.id, `🤒 ${virusNick} стало хуже (стадия ${virusRow.stage}→${result.newStage})`, threadOpts(msg)).catch(() => {});
          }
        }
```

(The outer gate now also excludes anyone already at `strain='beta', stage=4` — once a sex-zombie, always a sex-zombie, no further rolls of any kind, matching patient zero's existing exclusion pattern. `maxStage` is 4 only for beta, so alpha's worsen roll still caps at 3 exactly as before. The `result.newStage === 4` branch is checked BEFORE the generic `worsen` branch so the special transformation message fires instead of the generic "стало хуже" one specifically for that transition — this branch is only reachable when `maxStage === 4`, i.e., only for beta, since alpha's `Math.min(3, ...)` can never produce `newStage === 4`.)

- [ ] **Step 3: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual verification (static only)**

Do NOT run `node bot.js` locally (shared production token).

1. Confirm `VIRUS_SEXZOMBIE_PHRASES` (Task 1) is referenced correctly and `pick` is pre-existing.
2. Hand-trace: alpha user at stage 3, `maxStage=3` — worsen roll produces `Math.min(3, 4) = 3`, i.e., `newStage` stays 3, `result.newStage === 4` is never true for alpha — confirms alpha can never reach the transformation branch, matching the design (only beta has a stage-4 ceiling).
3. Hand-trace: beta user at stage 3, `maxStage=4` — worsen roll produces `Math.min(4, 4) = 4` — `result.newStage === 4` is true, transformation branch fires, `stage` is set to 4 explicitly (matching `result.newStage`).
4. Hand-trace: beta user already at stage 4 — the outer gate `!(virusRow.strain === 'beta' && virusRow.stage === 4)` is `false`, so the entire `if` block (including the cough-suffix's zombie branch, which is OUTSIDE this gate and still runs) is skipped for stage-change purposes, but the cough-suffix selection (Step 1, a separate code region earlier in the same cough block) still correctly selects a `VIRUS_SEXZOMBIE_PHRASES` entry every time this stage-4 user's cadence triggers a cough. Confirm these two edits (Step 1's suffix branch, Step 2's roll-exclusion) are independent and both correctly gate on the same `strain === 'beta' && stage === 4` condition without depending on each other.
5. Confirm `virusRow.stage === 4` (not `>= 4`) is precise enough given `maxStage` never exceeds 4 for either strain — stage can never exceed 4 in this codebase, so `=== 4` and `>= 4` are equivalent here; either reads fine, no ambiguity.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat(virus): wire up beta's stage-4 sex-zombie transformation and terminal exclusion"
```

---

### Task 4: Mutation on re-infection attempt

**Files:**
- Modify: `bot.js` (one edit, inside the cough-handling infection-spread loop)

- [ ] **Step 1: Add the mutation branch to the infection-spread loop**

Find this exact text in `bot.js`:

```js
        let anyInfected = false;
        for (const entry of virusPriorRecent) {
          if (getVirusRow(entry.userId)) continue;
          if (Math.random() < INFECT_CHANCE) {
            anyInfected = true;
            db.prepare(
              'INSERT OR REPLACE INTO virus_infections (user_id, chat_id, username, stage, is_patient_zero, immune, message_count, added_by, added_by_name) VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?)'
            ).run(entry.userId, msg.chat.id, entry.username, msg.from.id, virusNick);
            bot.sendMessage(msg.chat.id, `🦠 ${entry.username} заразился(-ась) от ${virusNick}!`, threadOpts(msg)).catch(() => {});
          }
        }
```

Replace with:

```js
        let anyInfected = false;
        for (const entry of virusPriorRecent) {
          const existingRow = getVirusRow(entry.userId);
          if (existingRow) {
            const canMutate = virusRow.strain === 'alpha' && virusRow.stage === 3 && existingRow.strain === 'alpha';
            if (canMutate && Math.random() < VIRUS_MUTATION_CHANCE) {
              db.prepare(
                'INSERT OR REPLACE INTO virus_infections (user_id, chat_id, username, stage, is_patient_zero, immune, message_count, strain, added_by, added_by_name) VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?, ?)'
              ).run(entry.userId, msg.chat.id, entry.username, 'beta', msg.from.id, virusNick);
              bot.sendMessage(msg.chat.id, `🧬 ${entry.username} подхватил(а) МУТИРОВАВШИЙ штамм от ${virusNick}! Старый иммунитет к DedoVirus.2026 больше не защищает!`, threadOpts(msg)).catch(() => {});
            }
            continue;
          }
          if (Math.random() < INFECT_CHANCE) {
            anyInfected = true;
            db.prepare(
              'INSERT OR REPLACE INTO virus_infections (user_id, chat_id, username, stage, is_patient_zero, immune, message_count, added_by, added_by_name) VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?)'
            ).run(entry.userId, msg.chat.id, entry.username, msg.from.id, virusNick);
            bot.sendMessage(msg.chat.id, `🦠 ${entry.username} заразился(-ась) от ${virusNick}!`, threadOpts(msg)).catch(() => {});
          }
        }
```

(`existingRow` is computed once and reused, instead of calling `getVirusRow` twice. The original behavior — `continue` past anyone with an existing row, entirely skipping the `INFECT_CHANCE` roll for them — is preserved exactly; the new `canMutate`/mutation-roll logic is purely additive INSIDE that same `if (existingRow)` branch, still ending in `continue` either way so a mutated-or-not existing-row target never falls through to the healthy-target `INFECT_CHANCE` branch below. `canMutate` requires the COUGHER to be `alpha` stage 3 specifically — a beta cougher, or an alpha cougher at any other stage, never triggers mutation, matching the design's single, narrow trigger condition. The mutation INSERT's column list matches the normal infection INSERT's column list with one addition (`strain`), and omits `reached_stage2`/`energy` exactly like the original does, relying on their schema defaults — consistent with the established convention in this file.)

- [ ] **Step 2: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual verification (static only)**

Do NOT run `node bot.js` locally (shared production token).

1. Confirm `VIRUS_MUTATION_CHANCE` (Task 1) is referenced correctly.
2. Hand-trace: alpha stage-3 cougher, target already has an alpha row (active infection OR immune, both cases satisfy `existingRow.strain === 'alpha'` since immune rows keep their strain value) → `canMutate` is `true` → 15% roll → on success, target's entire row is replaced with `strain='beta', stage=1, immune=0` — their prior alpha immunity or active-infection state is gone, replaced entirely. On failure (85%), nothing happens to them (still `continue`s past, matching original skip behavior).
3. Hand-trace: alpha stage-2 (not 3) cougher targeting an existing alpha row → `canMutate` is `false` (stage condition fails) → always just `continue`s, no mutation ever possible, matching "only stage-3 coughers can trigger mutation."
4. Hand-trace: beta cougher (any stage) targeting an existing row (alpha or beta) → `canMutate` is `false` (`virusRow.strain === 'alpha'` fails since the cougher is beta) → always just `continue`s — beta never spreads further mutations, keeping exactly 2 strains total as designed.
5. Hand-trace: alpha stage-3 cougher targeting someone whose existing row is ALREADY `strain='beta'` → `canMutate` is `false` (`existingRow.strain === 'alpha'` fails) → just `continue`s, no double-mutation, no alpha-over-beta overwrite.
6. Confirm the mutation announcement (🧬 message) is visibly different from both the normal infection announcement (🦠) and the reaction-spread announcement, so players can tell mutation apart from ordinary spread at a glance.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat(virus): trigger strain mutation when a stage-3 cougher re-infects an already-alpha target"
```

---

### Task 5: `formatVirusList()` strain-aware emoji scheme

**Files:**
- Modify: `bot.js` (one function)

- [ ] **Step 1: Update the emoji logic**

Find this exact text in `bot.js`:

```js
  for (const row of rows) {
    const emoji = row.is_patient_zero ? '💀' : row.stage === 1 ? '🤧' : row.stage === 2 ? '🧟' : '🤢';
    const procs = getActiveVirusProcedureTypes(row.user_id);
    const procText = procs.length ? ` (${procs.map(p => `${VIRUS_PROCEDURE_ICONS[p] || '💉'} ${p}`).join(', ')})` : '';
    lines.push(`${emoji} ${row.username}${procText}`);
  }
  const immuneRows = db.prepare('SELECT username FROM virus_infections WHERE immune = 1 ORDER BY created_at').all();
  lines.push('');
  lines.push(`Всего переболело: ${rows.length + immuneRows.length}`);
  if (immuneRows.length) {
    lines.push(`✅ С иммунитетом (${immuneRows.length}): ${immuneRows.map(r => r.username).join(', ')}`);
  }
```

Replace with:

```js
  for (const row of rows) {
    let emoji;
    if (row.is_patient_zero) emoji = '💀';
    else if (row.strain === 'beta' && row.stage === 4) emoji = VIRUS_ZOMBIE_ICON;
    else emoji = (VIRUS_STRAIN_ICONS[row.strain] || '🦠').repeat(row.stage);
    const procs = getActiveVirusProcedureTypes(row.user_id);
    const procText = procs.length ? ` (${procs.map(p => `${VIRUS_PROCEDURE_ICONS[p] || '💉'} ${p}`).join(', ')})` : '';
    lines.push(`${emoji} ${row.username}${procText}`);
  }
  const immuneRows = db.prepare('SELECT username, strain FROM virus_infections WHERE immune = 1 ORDER BY created_at').all();
  lines.push('');
  lines.push(`Всего переболело: ${rows.length + immuneRows.length}`);
  if (immuneRows.length) {
    lines.push(`✅ С иммунитетом (${immuneRows.length}): ${immuneRows.map(r => `${VIRUS_STRAIN_ICONS[r.strain] || '🦠'} ${r.username}`).join(', ')}`);
  }
```

(Patient zero keeps `💀` unconditionally, unchanged. Sex-zombies (`beta` + stage 4) get the single, non-repeated `VIRUS_ZOMBIE_ICON` (🧟) instead of a repeated strain icon — repeating it 4 times would look cluttered and doesn't match the "this is a distinct terminal status, not just a stage number" intent. Everyone else gets their strain's icon repeated `stage` times — 1, 2, or 3 copies. The immune list's `SELECT` now also fetches `strain` so each immune person's icon can be shown next to their name.)

- [ ] **Step 2: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual verification (static only)**

1. Hand-trace a small example: patient zero (`is_patient_zero=1`) → `💀`. Alpha stage 2 → `🦠🦠`. Beta stage 3 → `👾👾👾`. Beta stage 4 → `🧟` (not `👾👾👾👾`). Immune alpha person → `🦠 {username}` in the immune list; immune beta person → `👾 {username}`.
2. Confirm `VIRUS_STRAIN_ICONS[row.strain] || '🦠'` gracefully falls back to `🦠` for any row where `strain` is somehow neither `'alpha'` nor `'beta'` (shouldn't happen given the schema default and the only two INSERT paths that set it explicitly, but confirms no crash if it ever did).
3. Confirm this function's return type (string or `null`) is unchanged, so both `/epidemic` and the hourly broadcast (which call `formatVirusList()` with no changes needed on their end) keep working without modification.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat(virus): show strain-colored, stage-repeated emoji in /epidemic"
```

---

### Task 6: Guard `/cure` and `/immune` against sex-zombies

**Files:**
- Modify: `bot.js` (two commands)

- [ ] **Step 1: Refuse `/cure` on a sex-zombie**

Find this exact text in `bot.js`:

```js
  const row = getVirusRow(user.id);
  if (!row) return bot.sendMessage(msg.chat.id, `${user.username} не заражён`, threadOpts(msg));
  if (row.is_patient_zero) return bot.sendMessage(msg.chat.id, 'Нулевого пациента вылечить нельзя, используй /endvirus', threadOpts(msg));

  db.prepare('UPDATE virus_infections SET immune = 1 WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM virus_procedures WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} вылечен от DedoVirus и получил иммунитет`, threadOpts(msg));
});
```

Replace with:

```js
  const row = getVirusRow(user.id);
  if (!row) return bot.sendMessage(msg.chat.id, `${user.username} не заражён`, threadOpts(msg));
  if (row.is_patient_zero) return bot.sendMessage(msg.chat.id, 'Нулевого пациента вылечить нельзя, используй /endvirus', threadOpts(msg));
  if (row.strain === 'beta' && row.stage === 4) return bot.sendMessage(msg.chat.id, 'Секс-зомби вылечить нельзя, используй /endvirus', threadOpts(msg));

  db.prepare('UPDATE virus_infections SET immune = 1 WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM virus_procedures WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} вылечен от DedoVirus и получил иммунитет`, threadOpts(msg));
});
```

- [ ] **Step 2: Refuse `/immune` on a sex-zombie**

Find this exact text in `bot.js`:

```js
  db.prepare('UPDATE virus_infections SET energy = 0 WHERE user_id = ?').run(msg.from.id);

  if (virusRow.is_patient_zero) {
    return bot.sendMessage(msg.chat.id, `🦠 ${nick}: иммунная система бессильна против нулевого пациента`, threadOpts(msg));
  }
```

Replace with:

```js
  db.prepare('UPDATE virus_infections SET energy = 0 WHERE user_id = ?').run(msg.from.id);

  if (virusRow.is_patient_zero) {
    return bot.sendMessage(msg.chat.id, `🦠 ${nick}: иммунная система бессильна против нулевого пациента`, threadOpts(msg));
  }
  if (virusRow.strain === 'beta' && virusRow.stage === 4) {
    return bot.sendMessage(msg.chat.id, `🧟 ${nick}: иммунная система бессильна против секс-зомби`, threadOpts(msg));
  }
```

(Both refusals happen AFTER energy is reset to 0 — matching `/immune`'s existing rule that energy is always spent regardless of outcome, same as the pre-existing patient-zero refusal right below it.)

- [ ] **Step 3: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual verification (static only)**

1. Confirm `/cure`'s new guard sits AFTER the `is_patient_zero` guard and BEFORE the `immune = 1` UPDATE — a sex-zombie's row is never touched.
2. Confirm `/immune`'s new guard sits AFTER the energy reset and the `is_patient_zero` check, BEFORE the 50% roll — a sex-zombie's energy is still spent (matching "always resets regardless of outcome"), but they never reach the coin flip.
3. Confirm neither guard affects non-zombie beta users (stage 1-3) — `row.stage === 4` is `false` for them, so both commands behave normally (curable/rollable) for beta stages 1-3, exactly like alpha.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat(virus): make sex-zombies immune to /cure and /immune, only /endvirus works"
```

---

### Task 7: Deploy and full end-to-end smoke test

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

1. Get someone to alpha stage 3 (via `/0patient` reaching stage 3 naturally is not possible since patient zero is exempt from rolls — instead, get a naturally-infected alpha user to worsen twice via cough rolls, or use `/topor`/repeated coughing to speed it along).
2. Get a SECOND person already infected (or cured/immune) with alpha, positioned among the "last 3 messages" before the stage-3 person's next cough.
3. Wait for coughs (probabilistic — may take many attempts across both the 30% cough chance and the 15% mutation chance) until the mutation message (`🧬 ... подхватил(а) МУТИРОВАВШИЙ штамм ...`) appears for the second person.
4. `/epidemic` — confirm the mutated person shows `👾` (× their current stage) instead of `🦠`, and that a genuinely-alpha person nearby still shows `🦠` × stage.
5. Let the mutated (beta) person worsen via cough rolls until they reach stage 4 — confirm the `🧟 ... превратился(-ась) в секс-зомби!` announcement appears, and from then on their coughs show one of the `VIRUS_SEXZOMBIE_PHRASES` lines instead of the normal stage phrases.
6. Confirm `/cure` on the sex-zombie is refused with `'Секс-зомби вылечить нельзя, используй /endvirus'` (Task 6), and `/immune` on them is refused with the `🧟 ... иммунная система бессильна против секс-зомби` message (also spending their energy, per Task 6's design).
7. Confirm `/epidemic` shows the zombie as `🧟` (not repeated), separate from both alpha and beta's repeated-icon display.
8. Confirm the "С иммунитетом" list in `/epidemic` shows the correct strain icon (🦠 or 👾) next to anyone who has recovered from either strain.

- [ ] **Step 4: Report back**

No commit needed — final live verification only.

---

## Self-Review Notes

- **Spec coverage:** every point in the design addendum maps to a task — schema/constants (Task 1), `maxStage` plumbing (Task 2), zombie transformation/exclusion/cough-phrase (Task 3), mutation trigger (Task 4), display (Task 5), and a gap caught during self-review — `/cure`/`/immune` (built in an earlier plan) had no zombie-specific refusal — closed by Task 6 rather than left for the smoke test to merely discover.
- **Placeholder scan:** no TBDs; every step has complete code or an exact command with expected output.
- **Type/name consistency:** `VIRUS_MUTATION_CHANCE`, `VIRUS_STRAIN_ICONS`, `VIRUS_ZOMBIE_ICON`, `VIRUS_SEXZOMBIE_PHRASES`, `maxStage`, `strain` are each defined exactly once (Task 1/2) and referenced identically in every later task.
