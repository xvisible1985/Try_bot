# DedoVirus.2026 Reaction Infection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second infection vector to the existing DedoVirus.2026 feature: a currently-infected user can infect a healthy one by reacting (any emoji, added not removed) to that healthy user's message, with a per-stage probability (1%/3%/5%). Also retrofit the existing cough-spread infection announcement to name the source, matching the new reaction announcement's wording.

**Architecture:** Same single-file `bot.js` convention as the rest of this feature. Requires enabling `message_reaction` updates (currently not requested by this bot's polling at all), a new in-memory message-id → author lookup (Telegram's `message_reaction` update never includes who wrote the reacted-to message), and one new `bot.on('message_reaction', ...)` handler reusing the existing `virus_infections` table and `getVirusRow` helper.

**Tech Stack:** Node.js, `node-telegram-bot-api` (confirmed installed version 0.66.0 emits `message_reaction` events and exposes `setMessageReaction`, so no dependency changes needed), `better-sqlite3`. Same "no test framework, manual/static verification" approach as the rest of this project (see the original DedoVirus.2026 plan for the established rationale) — this plan follows that same pattern.

Full design: `docs/superpowers/specs/2026-07-16-dedovirus-2026-design.md`, section "Addendum: reaction-based infection".

**IMPORTANT for every task below — do NOT run `node bot.js` locally.** The project's `.env` `BOT_TOKEN` is shared with the production bot (running via PM2 on a separate server); a second local long-polling instance against the same token causes Telegram API conflicts for production. Static verification (`node --check`, code reading, hand-tracing) only — live verification happens in Task 3's deploy/smoke-test step.

---

### Task 1: Constants, message-author tracking, and enabling reaction updates

**Files:**
- Modify: `bot.js` (four insertion/edit points, see below)

- [ ] **Step 1: Add the per-stage reaction-infection chance constant**

Find this exact text in `bot.js` (unique comment, immediately after the existing DedoVirus.2026 constants block):

```js
// Dahlʼs dictionary meanings for common swear roots
```

Replace with:

```js
const REACTION_INFECT_CHANCE = { 1: 0.01, 2: 0.03, 3: 0.05 };

// Dahlʼs dictionary meanings for common swear roots
```

- [ ] **Step 2: Add the message-author map and its two helpers**

Find this exact text in `bot.js` (unique section header, immediately after the existing `virusRecentMessages`/`getVirusRecent`/`pushVirusRecent` block):

```js
// --- Commands ---
```

Replace with:

```js
const messageAuthors = new Map(); // "chatId:messageId" -> { userId, username }, capped at 500

function rememberMessageAuthor(chatId, messageId, author) {
  const key = `${chatId}:${messageId}`;
  messageAuthors.set(key, author);
  if (messageAuthors.size > 500) messageAuthors.delete(messageAuthors.keys().next().value);
}

function getMessageAuthor(chatId, messageId) {
  return messageAuthors.get(`${chatId}:${messageId}`);
}

// --- Commands ---
```

(This tracks every message's author so a later `message_reaction` update — which only tells us the reacted-to message's id, never its author — can look the author back up. Capped at 500 entries with FIFO eviction via `Map`'s insertion-order iteration, same in-memory/restart-resets trade-off already accepted for `virusRecentMessages`/`fishingTracker` elsewhere in this file.)

- [ ] **Step 3: Populate the map at the top of the message handler**

Find this exact text in `bot.js` (the top of the shared message handler, right after Task 3 of the original plan's virus-recent-messages wiring):

```js
  const virusNick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const virusPriorRecent = getVirusRecent(msg.chat.id);
  pushVirusRecent(msg.chat.id, { userId: msg.from.id, username: virusNick });
```

Replace with:

```js
  const virusNick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const virusPriorRecent = getVirusRecent(msg.chat.id);
  pushVirusRecent(msg.chat.id, { userId: msg.from.id, username: virusNick });
  rememberMessageAuthor(msg.chat.id, msg.message_id, { userId: msg.from.id, username: virusNick });
```

- [ ] **Step 4: Enable `message_reaction` updates in polling**

Find this exact text in `bot.js` (inside `skipOldUpdates` and `poll`):

```js
async function skipOldUpdates() {
  try {
    const updates = await Promise.race([
      bot.getUpdates({ offset: -1, limit: 1, timeout: 0 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    if (updates.length > 0) offset = updates[updates.length - 1].update_id + 1;
  } catch {}
}

async function poll() {
  try {
    const params = { timeout: 0, limit: 10 };
    if (offset !== undefined) params.offset = offset;
```

Replace with:

```js
async function skipOldUpdates() {
  try {
    const updates = await Promise.race([
      bot.getUpdates({ offset: -1, limit: 1, timeout: 0, allowed_updates: ['message', 'message_reaction'] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    if (updates.length > 0) offset = updates[updates.length - 1].update_id + 1;
  } catch {}
}

async function poll() {
  try {
    const params = { timeout: 0, limit: 10, allowed_updates: ['message', 'message_reaction'] };
    if (offset !== undefined) params.offset = offset;
```

This is the most operationally important change in this task: without `allowed_updates` explicitly including `message_reaction`, Telegram will never deliver reaction updates to this bot's `getUpdates` calls, no matter what handler code exists. `'message'` must stay in the list (it's the only other update type this bot currently consumes) or every existing command/feature would stop receiving updates entirely.

- [ ] **Step 5: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Manual verification (static only)**

Do NOT run `node bot.js` locally (shared production token). Instead:
1. Confirm `getVirusRow` (used by a later task) and `virusNick`/`virusPriorRecent`/`pushVirusRecent` (from the original plan) are unaffected by this edit — read the full new top-of-handler block and confirm nothing was duplicated or reordered.
2. Confirm both `allowed_updates` arrays are identical (`['message', 'message_reaction']`) in both `skipOldUpdates` and `poll` — a mismatch between the two wouldn't break anything today (both end up calling the same underlying `getUpdates`), but should still read as intentional and consistent.
3. Confirm `messageAuthors` is declared once, at module scope, not inside any function (so it persists across calls, the same way `virusRecentMessages`/`fishingTracker` do).

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat(virus): track message authors and enable message_reaction updates"
```

---

### Task 2: `message_reaction` handler — infection via reaction

**Files:**
- Modify: `bot.js` (insert right before `bot.on('polling_error', ...)`, at the end of the file)

- [ ] **Step 1: Add the handler**

Find this exact text in `bot.js` (the last handful of lines in the file):

```js
bot.on('polling_error', (err) => console.error('polling_error:', err.message));
```

Replace with:

```js
bot.on('message_reaction', async (reaction) => {
  const reactorId = reaction.user?.id;
  if (!reactorId) return;
  if (!reaction.new_reaction || !reaction.new_reaction.length) return;

  const author = getMessageAuthor(reaction.chat.id, reaction.message_id);
  if (!author) return;
  if (author.userId === reactorId) return;
  if (getVirusRow(author.userId)) return;

  const reactorRow = getVirusRow(reactorId);
  if (!reactorRow || reactorRow.immune) return;

  const stage = reactorRow.is_patient_zero ? 3 : reactorRow.stage;
  const chance = REACTION_INFECT_CHANCE[stage] || REACTION_INFECT_CHANCE[3];
  if (Math.random() >= chance) return;

  const reactorNick = reaction.user.username ? `@${reaction.user.username}` : reaction.user.first_name;
  db.prepare(
    'INSERT OR REPLACE INTO virus_infections (user_id, chat_id, username, stage, is_patient_zero, immune, message_count, added_by, added_by_name) VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?)'
  ).run(author.userId, reaction.chat.id, author.username, reactorId, reactorNick);
  bot.sendMessage(reaction.chat.id, `🦠 ${author.username} заразился(-ась) от ${reactorNick}!`).catch(() => {});
});

bot.on('polling_error', (err) => console.error('polling_error:', err.message));
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual verification (static only)**

Do NOT run `node bot.js` locally. Instead:
1. Confirm every identifier this handler references already exists from prior tasks/commits: `getMessageAuthor` (Task 1 of this plan), `getVirusRow` (original plan, Task 2), `REACTION_INFECT_CHANCE` (Task 1 of this plan), `db`.
2. Hand-trace the guard order against the design doc's addendum section (`docs/superpowers/specs/2026-07-16-dedovirus-2026-design.md`): no `reaction.user` → return; reaction removal (`new_reaction` empty) → return; unknown message → return; self-reaction → return; author already has a row (infected or immune) → return; reactor has no row or is immune → return; then roll the stage-based chance; on success, insert + announce.
3. Confirm the stage lookup (`reactorRow.is_patient_zero ? 3 : reactorRow.stage`) matches how the cough-cadence logic already treats patient zero as stage 3 (original plan, Task 5) — same convention, not a new one.
4. Confirm the INSERT's column list and placeholder order match `virus_infections`'s schema exactly (same 9-column pattern used by every other INSERT into this table in the codebase — `/0patient`, the cough-spread path).
5. Confirm this handler doesn't `return` a Promise the caller awaits anywhere that would matter (it's a `bot.on(...)` listener, fire-and-forget is correct, matching how `bot.on('message', ...)` is also just registered and never awaited by the caller).

Live verification (actually reacting to a message in the real chat and observing an infection) happens in Task 3's deploy/smoke-test step.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat(virus): infect healthy users via reactions from the sick"
```

---

### Task 3: Retrofit the cough-spread announcement to name the source, then deploy and smoke-test

**Files:**
- Modify: `bot.js` (one text replacement)

- [ ] **Step 1: Update the cough-spread infection announcement**

Find this exact text in `bot.js` (inside the cough/infection block from the original plan's Task 5):

```js
            bot.sendMessage(msg.chat.id, `🦠 ${entry.username} заразился(-ась)!`, threadOpts(msg)).catch(() => {});
```

Replace with:

```js
            bot.sendMessage(msg.chat.id, `🦠 ${entry.username} заразился(-ась) от ${virusNick}!`, threadOpts(msg)).catch(() => {});
```

(`virusNick` is already in scope at this point in the handler — it's the coughing/infecting user's nick, computed at the very top of `bot.on('message', ...)`. This makes the cough-spread announcement's wording match the new reaction-spread announcement added in Task 2 of this plan: both now read `🦠 {ник} заразился(-ась) от {источник}!`.)

- [ ] **Step 2: Verify the file still parses**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat(virus): name the infection source in the cough-spread announcement too"
```

- [ ] **Step 4: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 5: Deploy on the prod server**

SSH in (`xvisible1985@91.224.86.8`), `sudo -i`, then:

```bash
cd /root/Try_bot
git pull origin main
npm ci --production
pm2 restart tg-bot --update-env
pm2 logs tg-bot --lines 20 --nostream
```

Expected: `Бот запущен...` with no stack traces or `unhandledRejection` entries — specifically watch for anything reaction-related, since this is the first time this bot has ever requested `message_reaction` updates from Telegram.

- [ ] **Step 6: Full manual playthrough in the real chat**

1. Get someone infected (via `/0patient` or letting a cough spread naturally, from the existing feature).
2. Have a healthy (never-infected) user post a message.
3. Have the infected user react to that message with any emoji.
4. Confirm: with the stated probability for their stage (1%/2%/5% — may take several attempts since it's a low-probability roll, especially at stage 1), the healthy user eventually gets infected and the chat receives `🦠 {ник} заразился(-ась) от {источник}!`.
5. Have the infected user react to their OWN message — confirm no infection roll happens (self-reaction guard).
6. Have an infected user react to an ALREADY-infected (or immune/cured) user's message — confirm no duplicate infection/announcement.
7. Trigger a natural cough-spread infection (from the existing mechanic) and confirm ITS announcement now also reads `...заразился(-ась) от {источник}!` instead of the old wording without a source.

- [ ] **Step 7: Report back**

No commit needed for this step — it's the final live verification.

---

## Self-Review Notes

- **Spec coverage:** the design addendum's every point maps to a task — enabling `message_reaction` updates and the author-lookup map (Task 1), the reaction-infection handler itself (Task 2), and the announcement-wording retrofit for both infection paths (Task 3, plus Task 2's new handler already uses the new wording from the start).
- **Placeholder scan:** no TBDs; every step has complete code or an exact command with expected output.
- **Type/name consistency:** `rememberMessageAuthor`, `getMessageAuthor`, `messageAuthors`, `REACTION_INFECT_CHANCE` are each defined exactly once (Task 1) and referenced with the same name/signature in Task 2. `virusNick` (Task 3 of this plan) is the same pre-existing identifier from the original plan's Task 3, not redefined.
- **Regression risk:** the only edit touching pre-existing, already-shipped behavior is the `allowed_updates` change in Task 1 Step 4 — explicitly keeps `'message'` in the list so no existing feature loses its update stream, and the cough-announcement wording change in Task 3 (additive text only, no logic change).
