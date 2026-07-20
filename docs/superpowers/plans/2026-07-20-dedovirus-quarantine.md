# DedoVirus.2026 Quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/quarantine`, an admin-only, chat-wide, 24-hour temporary modifier to the already-shipped DedoVirus.2026 feature: infection/mutation risk ×0.4, recovery chance ×2.

**Architecture:** One new single-row table (`virus_quarantine`), one helper (`isQuarantineActive()`), one new command, and the multiplier threaded into the 4 existing probability rolls it affects (cough-infect, mutation, reaction-infect, stage-improve).

Full design: `docs/superpowers/specs/2026-07-16-dedovirus-2026-design.md`, section "Addendum: `/quarantine`".

**IMPORTANT — do NOT run `node bot.js` locally.** Shared production `BOT_TOKEN` with the live PM2-managed bot. Static verification (`node --check`, code reading, hand-tracing) only.

---

### Task 1: Schema, constants, helper, and the `/quarantine` command

**Files:** Modify `bot.js` (four insertion points)

- [ ] **Step 1: Add the `virus_quarantine` table**

Find this exact text:
```js
db.exec(`
  CREATE TABLE IF NOT EXISTS virus_procedures (
    user_id INTEGER NOT NULL,
    procedure_type TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, procedure_type)
  )
`);
```
Replace with:
```js
db.exec(`
  CREATE TABLE IF NOT EXISTS virus_procedures (
    user_id INTEGER NOT NULL,
    procedure_type TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, procedure_type)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS virus_quarantine (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    expires_at INTEGER NOT NULL
  )
`);
```

- [ ] **Step 2: Add constants**

Find this exact text:
```js
const REACTION_INFECT_CHANCE = { 1: 0.01, 2: 0.03, 3: 0.05 };
```
Replace with:
```js
const REACTION_INFECT_CHANCE = { 1: 0.01, 2: 0.03, 3: 0.05 };
const VIRUS_QUARANTINE_DURATION_MS = 24 * 60 * 60 * 1000;
const VIRUS_QUARANTINE_RISK_MULTIPLIER = 0.4;
const VIRUS_QUARANTINE_IMPROVE_MULTIPLIER = 2;
```

- [ ] **Step 3: Add the `isQuarantineActive()` helper**

Find this exact text:
```js
function getVirusRow(userId) {
```
Replace with:
```js
function isQuarantineActive() {
  const row = db.prepare('SELECT expires_at FROM virus_quarantine WHERE id = 1').get();
  return !!row && row.expires_at * 1000 > Date.now();
}

function getVirusRow(userId) {
```

- [ ] **Step 4: Add the `/quarantine` command**

Find this exact text (unique section header):
```js
// --- List animals ---
```
Replace with:
```js
bot.onText(/\/quarantine\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const expiresAt = Math.floor((Date.now() + VIRUS_QUARANTINE_DURATION_MS) / 1000);
  db.prepare('INSERT OR REPLACE INTO virus_quarantine (id, expires_at) VALUES (1, ?)').run(expiresAt);
  bot.sendMessage(msg.chat.id, '🏥 Объявлен карантин на 24 часа! Заразиться сложнее, вылечиться — легче.', threadOpts(msg));
});

// --- List animals ---
```

- [ ] **Step 5:** Run `node --check bot.js` — expect no output.

- [ ] **Step 6: Manual verification (static only)**
1. Confirm `getVirusRow` is otherwise unchanged — only a new function was inserted before it.
2. Confirm re-running `/quarantine` while already active correctly refreshes `expires_at` via `INSERT OR REPLACE` (single row, `id` fixed at 1) rather than creating a second row or erroring.
3. Confirm `isAdmin` is the same pre-existing gate used by `/endvirus`.

- [ ] **Step 7: Commit**
```bash
git add bot.js
git commit -m "feat(virus): add /quarantine command and its schema/constants"
```

---

### Task 2: Apply the multiplier to cough-spread infect, mutation, and stage-improve rolls

**Files:** Modify `bot.js` (three edits, all inside the same combined cough-handling block)

- [ ] **Step 1: Snapshot quarantine status once at the top of the block**

Find this exact text:
```js
  if (msg.text && !msg.text.startsWith('/') && !msg.text.startsWith('**')) {
    const virusRow = getVirusRow(msg.from.id);
    let virusText = msg.text;
```
Replace with:
```js
  if (msg.text && !msg.text.startsWith('/') && !msg.text.startsWith('**')) {
    const virusRow = getVirusRow(msg.from.id);
    const quarantineActive = isQuarantineActive();
    let virusText = msg.text;
```
(Computed once and reused at all three sites below, rather than calling `isQuarantineActive()` repeatedly — same DB read, same result, within one message's processing.)

- [ ] **Step 2: Apply to the mutation roll**

Find this exact text:
```js
            if (canMutate && Math.random() < VIRUS_MUTATION_CHANCE) {
```
Replace with:
```js
            if (canMutate && Math.random() < VIRUS_MUTATION_CHANCE * (quarantineActive ? VIRUS_QUARANTINE_RISK_MULTIPLIER : 1)) {
```

- [ ] **Step 3: Apply to the cough-spread infect roll**

Find this exact text:
```js
          if (Math.random() < INFECT_CHANCE) {
            anyInfected = true;
```
Replace with:
```js
          if (Math.random() < INFECT_CHANCE * (quarantineActive ? VIRUS_QUARANTINE_RISK_MULTIPLIER : 1)) {
            anyInfected = true;
```

- [ ] **Step 4: Apply to the stage-improve roll**

Find this exact text:
```js
          const improveChance = BASE_IMPROVE_CHANCE + getVirusProcedureBonus(msg.from.id);
```
Replace with:
```js
          const improveChance = BASE_IMPROVE_CHANCE * (quarantineActive ? VIRUS_QUARANTINE_IMPROVE_MULTIPLIER : 1) + getVirusProcedureBonus(msg.from.id);
```
(Multiplier applies to the base rate only — procedure bonuses from `getVirusProcedureBonus` stay additive on top, unchanged.)

- [ ] **Step 5:** Run `node --check bot.js` — expect no output.

- [ ] **Step 6: Manual verification (static only)**
1. Confirm `quarantineActive` is declared once, before all three use sites, and none of the three sites call `isQuarantineActive()` directly anymore.
2. Hand-trace: quarantine inactive → all three multipliers are effectively `* 1`, i.e. byte-identical behavior to before this task (no regression when quarantine has never been declared).
3. Hand-trace: quarantine active → `INFECT_CHANCE` (0.25) effectively becomes 0.10, `VIRUS_MUTATION_CHANCE` (0.15) becomes 0.06, `BASE_IMPROVE_CHANCE` (0.10) becomes 0.20 before procedure bonuses.
4. Confirm `WORSEN_CHANCE` is untouched — quarantine only affects infection/mutation/improve rolls, not the worsen roll, per the design (not asked to change worsening).

- [ ] **Step 7: Commit**
```bash
git add bot.js
git commit -m "feat(virus): apply quarantine multiplier to cough-spread infection, mutation, and recovery rolls"
```

---

### Task 3: Apply the multiplier to reaction-spread, update `/help`, deploy and smoke-test

**Files:** Modify `bot.js` (two edits)

- [ ] **Step 1: Apply to the reaction-spread infect roll**

Find this exact text:
```js
  const stage = reactorRow.is_patient_zero ? 3 : reactorRow.stage;
  const chance = REACTION_INFECT_CHANCE[stage] || REACTION_INFECT_CHANCE[3];
  if (Math.random() >= chance) return;
```
Replace with:
```js
  const stage = reactorRow.is_patient_zero ? 3 : reactorRow.stage;
  const baseChance = REACTION_INFECT_CHANCE[stage] || REACTION_INFECT_CHANCE[3];
  const chance = baseChance * (isQuarantineActive() ? VIRUS_QUARANTINE_RISK_MULTIPLIER : 1);
  if (Math.random() >= chance) return;
```
(This is a separate function — `bot.on('message_reaction', ...)` — from the cough-handling block, so it needs its own `isQuarantineActive()` call; it isn't sharing `quarantineActive` from Task 2, which lives in a different function's scope.)

- [ ] **Step 2: Add `/quarantine` to `/help`**

Find this exact text:
```js
    '/ukol /klizma /topor /massage — процедуры (ответ на сообщение, админ)',
  ].join('\n');
```
Replace with:
```js
    '/ukol /klizma /topor /massage — процедуры (ответ на сообщение, админ)',
    '/quarantine — карантин на 24ч: риск заражения ×0.4, шанс выздоровления ×2 (админ)',
  ].join('\n');
```

- [ ] **Step 3:** Run `node --check bot.js` — expect no output.

- [ ] **Step 4: Manual verification (static only)**
1. Confirm `baseChance`/`chance` split reads clearly and `REACTION_INFECT_CHANCE[stage]`'s original lookup logic (including the `|| REACTION_INFECT_CHANCE[3]` patient-zero fallback) is unchanged, just renamed and then multiplied.
2. Confirm `VIRUS_QUARANTINE_RISK_MULTIPLIER` (from Task 1) is accessible in this function's scope (it's a module-level `const`, so yes).

- [ ] **Step 5: Commit**
```bash
git add bot.js
git commit -m "feat(virus): apply quarantine multiplier to reaction-spread infection, document in /help"
```

- [ ] **Step 6: Push and deploy**
```bash
git push origin main
```
Then on the prod server:
```bash
cd /root/Try_bot
git pull origin main
npm ci --production
pm2 restart tg-bot --update-env
pm2 logs tg-bot --lines 20 --nostream
```

- [ ] **Step 7: Live smoke test**
1. `/quarantine` as admin — confirm the announcement.
2. With quarantine active, observe that cough-based infection/mutation announcements become noticeably rarer and stage-improve (💊/✅) messages become noticeably more common than usual (probabilistic, not deterministic — this is a "should feel different over many messages," not a single-message guarantee).
3. Re-run `/quarantine` while already active — confirm no error, no duplicate row (only ever one active window).
4. `/help` shows the new `/quarantine` line.

---

## Self-Review Notes
- **Spec coverage:** schema/constants/helper/command (Task 1), cough-side multipliers (Task 2), reaction-side multiplier + docs (Task 3) — covers every roll the design addendum lists.
- **No double-counting:** `quarantineActive` is computed once per function invocation in each of the two affected functions (cough handler, reaction handler) — no risk of the two functions' independent `isQuarantineActive()` reads disagreeing mid-message, since each function only ever calls it once (Task 2's snapshot; Task 3's inline call).
- **Type/name consistency:** `isQuarantineActive`, `VIRUS_QUARANTINE_DURATION_MS`, `VIRUS_QUARANTINE_RISK_MULTIPLIER`, `VIRUS_QUARANTINE_IMPROVE_MULTIPLIER`, `quarantineActive` each defined once, referenced identically everywhere else.
