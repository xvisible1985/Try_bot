require('dotenv').config();
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const Database = require('better-sqlite3');
// const { createWorker } = require('tesseract.js'); // OCR отключён

const token = process.env.BOT_TOKEN;
const proxy = process.env.PROXY_URL;
let agent;
if (proxy) {
  // keepAlive is essential: the low-powered proxy server drops ~half of fresh
  // SOCKS+Reality handshakes under concurrency, so reuse one warm tunnel
  // connection instead of a new handshake per call. Mirrors the StickerFon3
  // bot's proxy setup (socks5h:// → remote DNS through the tunnel).
  const agentOpts = { keepAlive: true, keepAliveMsecs: 60000, maxSockets: 5, maxFreeSockets: 3 };
  if (proxy.startsWith('socks')) {
    agent = new SocksProxyAgent(proxy, agentOpts);
  } else {
    agent = new HttpsProxyAgent(proxy, agentOpts);
  }
}
// polling: true — this bot receives commands via long-polling; without it the
// onText/on('message') handlers below never fire. The request agent routes both
// the getUpdates poll and all API calls through the proxy tunnel.
const bot = new TelegramBot(token, { polling: { autoStart: false }, request: { agent } });

// Dedupe by update_id. Long-polling over the flaky proxy tunnel occasionally
// loses a getUpdates response in transit (socket reset mid-flight) even
// though it already reached Telegram; the library then retries with the
// same offset, and if both the stalled and retried requests eventually
// resolve, the same update gets delivered — and processed/replied-to —
// twice. Telegram's update_id is unique and increasing, so tracking a
// bounded window of recently-seen ids is a safe, low-cost way to drop the
// duplicate without touching every individual handler.
const seenUpdateIds = new Set();
const seenUpdateQueue = [];
const MAX_SEEN_UPDATES = 500;
const originalProcessUpdate = bot.processUpdate.bind(bot);
bot.processUpdate = (update) => {
  if (update.update_id != null) {
    if (seenUpdateIds.has(update.update_id)) {
      console.log('duplicate update skipped:', update.update_id);
      return;
    }
    seenUpdateIds.add(update.update_id);
    seenUpdateQueue.push(update.update_id);
    if (seenUpdateQueue.length > MAX_SEEN_UPDATES) {
      seenUpdateIds.delete(seenUpdateQueue.shift());
    }
  }
  return originalProcessUpdate(update);
};

// Most sendMessage/deleteMessage calls below have no individual .catch. Over
// the proxy tunnel a transient handshake failure rejects one of those promises,
// and on Node 22 an unhandled rejection terminates the process by default.
// Swallow it here so a proxy hiccup can't kill the bot — polling recovers on
// its own, and a single dropped reply is harmless for this chat utility.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason?.message || reason);
});

async function recognizeSticker(fileId) {
  return '';
}

// --- SQLite ---
const db = new Database('mutes.db');
// troll-bot (separate process, sibling repo) writes to this same file to
// mark users as "smelling of troll pee" — busy_timeout so a rare write
// collision between the two processes retries instead of throwing
// SQLITE_BUSY immediately.
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS mutes (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    muted_by INTEGER,
    muted_by_name TEXT,
    expires_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
// Written by troll-bot (see its pee/poop-game mechanics), read here.
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_smell (
    user_id INTEGER PRIMARY KEY,
    marked_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER NOT NULL
  )
`);
// 'poop' (the poop-trap loser, played as an ironic "smells of violets" line)
// vs 'pee' (plain "smells of troll pee") — see the reply logic below.
try {
  db.exec("ALTER TABLE troll_smell ADD COLUMN reason TEXT NOT NULL DEFAULT 'pee'");
} catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS pigs (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS animals (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    animal TEXT NOT NULL,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
// Weapon-triggered timed animal status (see WEAPON_DEFS.carrot and
// applyTimedAnimal below) — NULL means the existing PERMANENT status
// set by /pig, /cat, /fox etc. (unchanged), a timestamp means a timed
// status from a carrot hit that auto-expires. Same idiom as crutch's
// dimon_until column.
try {
  db.exec('ALTER TABLE animals ADD COLUMN animal_until INTEGER');
} catch {}
// Migrate existing pigs to animals table. Clears the source rows once
// migrated so this is a genuine one-time migration, not a resurrection
// script: without the DELETE, this runs unconditionally on every boot,
// so any user removed from `animals` (e.g. via /unpig) whose legacy
// `pigs` row was never touched would get silently re-inserted as a pig
// on the very next deploy — /unpig and /human only ever DELETE FROM
// animals, they never knew about this older table.
db.exec(`
  INSERT OR IGNORE INTO animals (user_id, chat_id, username, animal, added_by, added_by_name, created_at)
  SELECT user_id, chat_id, username, 'pig', added_by, added_by_name, created_at FROM pigs
`);
db.exec('DELETE FROM pigs');
db.exec(`
  CREATE TABLE IF NOT EXISTS fishers (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    expires_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
try { db.exec('ALTER TABLE fishers ADD COLUMN expires_at INTEGER'); } catch {};
db.exec(`
  CREATE TABLE IF NOT EXISTS ramzans (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS estets (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS podhalims (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS molchuns (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    expires_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS dimoniacs (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    message_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
// Weapon-triggered timed "old man Dimon" status (see WEAPON_DEFS.crutch
// and applyDimon below) — NULL means the existing PERMANENT status set
// by admin /dimon (unchanged), a timestamp means a timed status from a
// crutch hit that auto-expires. Separate ALTER since dimoniacs already
// existed before this column — same idiom as user_health's hidden_until.
try {
  db.exec('ALTER TABLE dimoniacs ADD COLUMN dimon_until INTEGER');
} catch {}

db.exec(`
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
    strain TEXT NOT NULL DEFAULT 'alpha',
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
try { db.exec('ALTER TABLE virus_infections ADD COLUMN reached_stage2 INTEGER DEFAULT 0'); } catch {};
try { db.exec('ALTER TABLE virus_infections ADD COLUMN energy INTEGER DEFAULT 0'); } catch {};
try { db.exec("ALTER TABLE virus_infections ADD COLUMN strain TEXT NOT NULL DEFAULT 'alpha'"); } catch {};
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

// Health for every chat participant (global per user_id, not per-chat —
// one health total across every chat this bot serves). Written here by the
// regen job below and the mute-reply branch; also written directly by
// troll-bot's "Драка" game via the same cross-process connection pattern
// already used for troll_smell (see troll-bot's bot.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS user_health (
    user_id INTEGER PRIMARY KEY,
    health INTEGER NOT NULL DEFAULT 100,
    max_health INTEGER NOT NULL DEFAULT 100,
    last_regen_at INTEGER
  )
`);
// /hide (see the PvP section below) — protects a person from /kick for 1h.
// Separate ALTER since the column didn't exist when user_health was first
// deployed.
try {
  db.exec('ALTER TABLE user_health ADD COLUMN hidden_until INTEGER');
} catch {}
// hidden_since marks when the CURRENT hide session actually started —
// preserved across a /hide refresh (extending hidden_until while already
// hidden doesn't reset it), so accrueHiddenSeconds/endHideSession below
// can compute an exact session duration on whichever code path first
// notices it ended, instead of guessing from "whenever we happened to
// check". See pvp_stats and isHidden further down.
try {
  db.exec('ALTER TABLE user_health ADD COLUMN hidden_since INTEGER');
} catch {}
// Bat's 30%-on-hit stun (see performKick's weapon.key === 'bat' block) —
// while active, the stunned person's own /kick refuses outright, same
// idiom as isHidden below (a plain lazy timestamp read, no separate
// cleanup needed).
try {
  db.exec('ALTER TABLE user_health ADD COLUMN stunned_until INTEGER');
} catch {}

// Per-fighter combat stats. hidden_seconds accrues only when a hide
// session definitively ends (see endHideSession) — "time NOT hidden" is
// derived at display time as (now - first_tracked_at - hidden_seconds)
// rather than kept as its own running bucket, so there's one source of
// truth instead of two counters that could drift apart.
db.exec(`
  CREATE TABLE IF NOT EXISTS pvp_stats (
    user_id INTEGER PRIMARY KEY,
    crit_count INTEGER NOT NULL DEFAULT 0,
    injuries_dealt INTEGER NOT NULL DEFAULT 0,
    hidden_seconds INTEGER NOT NULL DEFAULT 0,
    first_tracked_at INTEGER NOT NULL
  )
`);
// Four persistent combat attributes plus lifetime XP (see
// docs/superpowers/specs/2026-08-24-combat-attributes-design.md).
// Available (unspent) points are never stored separately — they're
// always computed live as floor(xp/100) - (sum of the four columns
// below), so the count can never drift out of sync with xp.
for (const [column, def] of [['accuracy', 'INTEGER NOT NULL DEFAULT 0'], ['strength', 'INTEGER NOT NULL DEFAULT 0'], ['agility', 'INTEGER NOT NULL DEFAULT 0'], ['endurance', 'INTEGER NOT NULL DEFAULT 0'], ['xp', 'INTEGER NOT NULL DEFAULT 0']]) {
  try {
    db.exec(`ALTER TABLE pvp_stats ADD COLUMN ${column} ${def}`);
  } catch {}
}
// /kick is now gated on both sides being a registered "воин" — see
// /warrior below. Starts at 0 (false) for everyone, including existing
// rows, so the whole playerbase re-registers under the new system.
try {
  db.exec('ALTER TABLE pvp_stats ADD COLUMN is_warrior INTEGER NOT NULL DEFAULT 0');
} catch {}
// Stockpiled arena-crate elixirs (see /pick, /restore, and /recharge
// further below) — unlike the knife, these aren't applied the instant
// they're picked up; they bank here until spent on demand.
for (const [column, def] of [['health_elixirs', 'INTEGER NOT NULL DEFAULT 0'], ['energy_elixirs', 'INTEGER NOT NULL DEFAULT 0']]) {
  try {
    db.exec(`ALTER TABLE pvp_stats ADD COLUMN ${column} ${def}`);
  } catch {}
}

// Arena crate drops (see arenaTick, /pick, /restore, and /recharge
// further below).
// current_batch_id increments on every drop; arena_crates.batch_id ties
// each crate to exactly one drop, which is what makes "1 crate per
// player per drop" checkable — a claimed_by row from an OLDER batch
// doesn't count against a player's current-batch claim.
db.exec(`
  CREATE TABLE IF NOT EXISTS arena_drop_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_drop_at INTEGER,
    current_batch_id INTEGER NOT NULL DEFAULT 0
  )
`);
db.prepare('INSERT OR IGNORE INTO arena_drop_state (id, last_drop_at, current_batch_id) VALUES (1, NULL, 0)').run();
db.exec(`
  CREATE TABLE IF NOT EXISTS arena_crates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    crate_type TEXT NOT NULL,
    claimed_by INTEGER
  )
`);

// Lightweight username/first-name cache keyed by user_id, refreshed on
// every incoming message (see the main message handler below) — nothing
// upstream of this already maps an arbitrary user_id back to a display
// name (weapon_ownership only resolves its own seeded owners), and /find
// needs to list every past fighter by name, not just weapon holders.
db.exec(`
  CREATE TABLE IF NOT EXISTS known_users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_seen_at INTEGER
  )
`);
// Energy: separate resource from health, spent 1-per-swing on /kick (and
// troll-bot's /fight, via its own cross-process connection to this same
// table), regenerating 1 per 20 minutes up to max_energy. Same
// ALTER-since-table-already-existed idiom as hidden_until above.
for (const [column, def] of [['energy', 'INTEGER NOT NULL DEFAULT 10'], ['max_energy', 'INTEGER NOT NULL DEFAULT 10'], ['last_energy_regen_at', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
  } catch {}
}
// Bleed, from the rusty scissors real weapon (see WEAPON_DEFS.scissors and
// applyBleed below) — bleed_until is when it naturally ends, bleed_chat_id
// is where the dedicated bleedTick (see far below) announces ticks/stops
// for this user, last_bleed_stop_attempt_at gates the 5-minute 50/50 roll
// to end it early. Same ALTER idiom as energy/hidden_until above.
for (const [column, def] of [['bleed_until', 'INTEGER'], ['bleed_chat_id', 'INTEGER'], ['last_bleed_stop_attempt_at', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
  } catch {}
}
// Больничка — automatic recovery state entered on knockout (see
// docs/superpowers/specs/2026-08-24-hospital-and-defend-design.md).
// NULL when not hospitalized; a unix timestamp (seconds) marking entry
// otherwise. Combined with health < HOSPITAL_EXIT_HEALTH (see
// isHospitalized below) to decide "still hospitalized" — there is no
// separate boolean column. Same ALTER idiom as energy/bleed above.
for (const [column, def] of [['hospitalized_since', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
  } catch {}
}
// Critical-hit injuries from "Драка" (see troll-bot) — one of 'arm' | 'leg'
// | 'head', always exactly one at a time (a fresh crit overwrites), lazily
// expired 24h after being set (checked at read time, same idiom as mutes/
// troll_smell rather than a separate cleanup job).
db.exec(`
  CREATE TABLE IF NOT EXISTS injuries (
    user_id INTEGER PRIMARY KEY,
    injury_type TEXT NOT NULL,
    injured_until INTEGER NOT NULL
  )
`);
// Singleton row gating the once-daily 04:00 full health restore (see the
// regen job below) — same CHECK (id = 1) singleton idiom troll-bot uses for
// troll_state, just here so the restore doesn't refire every tick during
// the 04:00 hour.
db.exec(`
  CREATE TABLE IF NOT EXISTS health_regen_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_full_restore_date TEXT
  )
`);
db.prepare('INSERT OR IGNORE INTO health_regen_state (id, last_full_restore_date) VALUES (1, NULL)').run();

// /kuniFun/kuniAlia/kuniTama self-buffs (see docs/superpowers/specs/
// 2026-08-16-kuni-buffs-design.md). Two independent slots — crit (written
// by kuniFun or kuniTama) and dodge (written by kuniAlia or kuniTama) —
// each with its own expiry. The three *_cd_until columns are independent
// per-command cooldowns, always equal to that command's own buff duration.
db.exec(`
  CREATE TABLE IF NOT EXISTS buffs (
    user_id INTEGER PRIMARY KEY,
    crit_mult REAL,
    crit_until INTEGER,
    dodge_mult REAL,
    dodge_until INTEGER,
    fun_cd_until INTEGER,
    alia_cd_until INTEGER,
    tama_cd_until INTEGER
  )
`);

// Защитная стойка — /defend below. Same ALTER-after-CREATE idiom as
// every other column added to an existing table in this project.
for (const [column, def] of [['defend_until', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE buffs ADD COLUMN ${column} ${def}`);
  } catch {}
}

// Real, stealable weapons (see WEAPON_DEFS below and, in the sibling
// troll-bot repo, docs/superpowers/specs/2026-08-07-real-weapons-design.md)
// — three rows, seeded once to their named starting owners by username. owner_user_id
// stays NULL until that username is seen in chat (see the message handler
// below); after that, and after any steal, owner_user_id/owner_username
// are always the live current holder. Same dual-create idiom as
// troll_smell/user_health above — troll-bot creates this table too, so
// deploy order between the two bots doesn't matter.
db.exec(`
  CREATE TABLE IF NOT EXISTS weapon_ownership (
    weapon_key TEXT PRIMARY KEY,
    seed_username TEXT,
    owner_type TEXT NOT NULL DEFAULT 'human',
    owner_user_id INTEGER,
    owner_username TEXT
  )
`);
// Natural-0 fumble drop (see /kick below): owner_type briefly becomes
// 'dropped' (owner_user_id repurposed to mean "who dropped it, so they
// can't immediately re-pick-up their own weapon" rather than "who holds
// it") with dropped_chat_id marking which chat it's lying in until the
// pickup listener in the main message handler hands it to whoever writes
// next there. A 'dropped' row matches neither 'human' nor 'troll' in any
// existing owner_type filter, so it's automatically excluded from
// getWeaponsFor/pickWeaponForAttacker for the duration.
try {
  db.exec('ALTER TABLE weapon_ownership ADD COLUMN dropped_chat_id INTEGER');
} catch {}
// The rusty knife's 3-hour decay timer (see WEAPON_DEFS.knife and
// arenaTick further below) — NULL for every other weapon, forever.
try {
  db.exec('ALTER TABLE weapon_ownership ADD COLUMN expires_at INTEGER');
} catch {}
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('carrot', 'MashaZaykaaa', 'human', NULL, NULL)").run();
// Дима has no public Telegram @username, so the usual seed_username lazy
// resolution (see the UPDATE ... WHERE seed_username = ? AND owner_user_id
// IS NULL below) can't apply to him — his numeric id is already known, so
// owner_user_id is populated immediately and seed_username stays NULL.
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('crutch', NULL, 'human', 736180284, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('horns', 'Tamasvi_Vamp', 'human', NULL, NULL)").run();
// Unlike every weapon above, the knife starts owned by nobody at all —
// owner_type = 'none' matches neither 'human' nor 'troll' nor 'dropped'
// in any existing filter, so it's invisible everywhere until /pick
// hands it to someone for the first time.
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('knife', NULL, 'none', NULL, NULL)").run();

// One-time (per boot, but INSERT OR IGNORE so it never overwrites a
// known_users row already populated live from a real message — see the
// main message handler) backfill for /find: known_users only starts
// recording going forward from whenever this feature first deployed, so
// without this, every fighter who existed before that point but hasn't
// messaged since shows up as a bare numeric id. Pulls whichever username
// happens to be attached to that user_id in any older per-feature table
// that already stored one before known_users existed — exact source
// doesn't matter, any valid username is equally good for display.
db.exec(`
  INSERT OR IGNORE INTO known_users (user_id, username, first_name, last_seen_at)
  SELECT user_id, username, NULL, 0
  FROM (
    SELECT user_id, username FROM mutes WHERE username IS NOT NULL
    UNION ALL SELECT user_id, username FROM animals WHERE username IS NOT NULL
    UNION ALL SELECT user_id, username FROM fishers WHERE username IS NOT NULL
    UNION ALL SELECT user_id, username FROM ramzans WHERE username IS NOT NULL
    UNION ALL SELECT user_id, username FROM estets WHERE username IS NOT NULL
    UNION ALL SELECT user_id, username FROM podhalims WHERE username IS NOT NULL
    UNION ALL SELECT user_id, username FROM molchuns WHERE username IS NOT NULL
    UNION ALL SELECT user_id, username FROM dimoniacs WHERE username IS NOT NULL
    UNION ALL SELECT owner_user_id, owner_username FROM weapon_ownership WHERE owner_username IS NOT NULL
  )
  GROUP BY user_id
`);

// Generic one-time-migration ledger — a plain "already deployed" schema
// change (an ALTER, a new table) is naturally idempotent and safe to
// rerun every boot, but a genuine one-off DATA fix (resetting existing
// rows) is not: rerunning it on every restart would keep undoing
// legitimate gameplay that happens afterward. Each migration name runs
// at most once, ever, across all future restarts.
db.exec('CREATE TABLE IF NOT EXISTS migrations_run (name TEXT PRIMARY KEY, run_at INTEGER)');
function runOnce(name, fn) {
  if (db.prepare('SELECT 1 FROM migrations_run WHERE name = ?').get(name)) return;
  fn();
  db.prepare('INSERT INTO migrations_run (name, run_at) VALUES (?, ?)').run(name, Math.floor(Date.now() / 1000));
}

// Returns every real weapon to its originally-seeded owner. Weapons
// with a seed_username (everyone except crutch) go back to NULL
// owner_user_id/owner_username, which the existing lazy-resolution
// UPDATE in the main message handler re-populates the next time that
// person writes anything — same mechanism as the very first seeding.
// crutch has no seed_username (see its own seed row's comment above),
// so its owner_user_id is restored directly.
runOnce('2026-08-24-reset-weapons-to-original-owners', () => {
  db.exec(
    "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = NULL, owner_username = NULL, dropped_chat_id = NULL " +
    "WHERE weapon_key IN ('bat', 'axe', 'scissors', 'carrot', 'horns')"
  );
  db.prepare(
    "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = 736180284, owner_username = NULL, dropped_chat_id = NULL WHERE weapon_key = 'crutch'"
  ).run();
});

// Zeroes every fighter's tracked combat stats and attributes — a fresh
// start alongside the new /warrior gate below. first_tracked_at resets
// to now too, so /me's "time outside чулан" doesn't show a huge
// leftover number computed against a now-stale old baseline. Does NOT
// touch health/energy/injuries/mutes/hidden state — none of that is
// "статистика", it's live game state, out of scope for this reset.
runOnce('2026-08-24-reset-combat-stats', () => {
  db.exec(
    "UPDATE pvp_stats SET crit_count = 0, injuries_dealt = 0, hidden_seconds = 0, " +
    "accuracy = 0, strength = 0, agility = 0, endurance = 0, xp = 0, first_tracked_at = strftime('%s','now')"
  );
});

// Full fresh start for every registered воин, requested after more
// testing had already piled up health/injury/XP state since the reset
// above: health and energy restored to max, every injury cleared, any
// mute caused by a combat knockout lifted (admin-issued mutes, any
// other muted_by_name, are untouched), and every pvp_stats counter
// zeroed again. is_warrior itself is left alone — everyone stays a
// registered воин, this only wipes accumulated progress, not
// registration, so nobody needs to run /warrior again.
runOnce('2026-08-24-full-fresh-start', () => {
  db.exec('UPDATE user_health SET health = max_health, energy = max_energy');
  db.exec('DELETE FROM injuries');
  db.exec("DELETE FROM mutes WHERE muted_by_name = 'драка'");
  db.exec(
    "UPDATE pvp_stats SET crit_count = 0, injuries_dealt = 0, hidden_seconds = 0, " +
    "accuracy = 0, strength = 0, agility = 0, endurance = 0, xp = 0, first_tracked_at = strftime('%s','now')"
  );
});

// Re-allocation reset requested after the fresh start above: every
// spent attribute point goes back to 0, and +300 XP is added on top of
// whatever each fighter already had (additive, not a flat overwrite —
// this stacks with anyone's real progress since the fresh-start reset
// rather than erasing it), so their available points recompute as
// floor((old_xp + 300) / 100) with 0 already spent.
runOnce('2026-08-24-attributes-reset-plus-300xp', () => {
  db.exec('UPDATE pvp_stats SET accuracy = 0, strength = 0, agility = 0, endurance = 0, xp = xp + 300');
});

// Correction: the additive +300 above stacked on top of whatever real
// XP some fighters had already earned by playing /kick in the gap
// between the fresh-start reset and this migration's own deploy, so
// the more active players ended up above the intended flat 300 - not a
// double-applied migration (each of the runOnce migrations above is
// still confirmed to fire exactly once), just additive stacking on
// real gameplay progress that happened at an inconvenient moment. This
// is a flat SET, not additive, specifically to give everyone the exact
// same fair 300-XP/0-spent starting line regardless of whatever
// inconsistent state they're currently in — real battle XP earned
// AFTER this point accrues normally on top of it, same as always.
runOnce('2026-08-24-fix-attributes-300xp-flat', () => {
  db.exec('UPDATE pvp_stats SET accuracy = 0, strength = 0, agility = 0, endurance = 0, xp = 300');
});

// Full rollback, unlike every reset above this one — is_warrior itself
// goes back to 0 too, so /kick refuses everyone again until they run
// /warrior fresh (which grants its own 300 XP at that point, same as
// any first-time registration). Health/energy restored to max,
// injuries cleared, combat-knockout mutes lifted (admin mutes
// untouched), every pvp_stats counter and attribute zeroed.
runOnce('2026-08-24-full-rollback-unregister-warriors', () => {
  db.exec('UPDATE user_health SET health = max_health, energy = max_energy');
  db.exec('DELETE FROM injuries');
  db.exec("DELETE FROM mutes WHERE muted_by_name = 'драка'");
  db.exec(
    "UPDATE pvp_stats SET is_warrior = 0, crit_count = 0, injuries_dealt = 0, hidden_seconds = 0, " +
    "accuracy = 0, strength = 0, agility = 0, endurance = 0, xp = 0, first_tracked_at = strftime('%s','now')"
  );
});

// Same full rollback again, requested a second time after more testing
// piled up new state — this time also resets max_energy back to its
// column default (10), undoing any permanent increase from spending
// points on выносливость via /levelup before this reset (the earlier
// rollback above only restored energy up to whatever max_energy already
// was, never touching an inflated cap itself).
runOnce('2026-08-24-full-rollback-2-with-max-energy-reset', () => {
  db.exec('UPDATE user_health SET max_energy = 10, energy = 10, health = max_health');
  db.exec('DELETE FROM injuries');
  db.exec("DELETE FROM mutes WHERE muted_by_name = 'драка'");
  db.exec(
    "UPDATE pvp_stats SET is_warrior = 0, crit_count = 0, injuries_dealt = 0, hidden_seconds = 0, " +
    "accuracy = 0, strength = 0, agility = 0, endurance = 0, xp = 0, first_tracked_at = strftime('%s','now')"
  );
});

// --- Animal definitions ---
const ANIMALS = {
  pig:    { emoji: '🐷', sound: 'Хрю-хрю' },
  cat:    { emoji: '🐱', sound: 'Мяяяяяууу' },
  fox:    { emoji: '🦊', sound: 'Фыр-фыр-фыр' },
  dog:    { emoji: '🐶', sound: 'Гав-гав' },
  cow:    { emoji: '🐄', sound: 'Мууууууу' },
  donkey: { emoji: '🫏', sound: 'Иа-ииа' },
};

// --- Compliments for /estet ---
const COMPLIMENTS = [
  'ты просто прелесть', 'у тебя прекрасная улыбка', 'ты удивительный человек',
  'ты очень умный', 'ты вдохновляешь меня', 'у тебя отличное чувство юмора',
  'ты настоящий профессионал', 'с тобой так приятно общаться', 'ты очень надёжный',
  'у тебя прекрасная душа', 'ты делаешь мир лучше', 'ты невероятно талантлив',
  'твоя доброта восхищает', 'ты самый обаятельный', 'у тебя золотые руки',
  'ты молодец, серьёзно', 'с тобой всегда весело', 'ты очень проницательный',
  'у тебя великолепный вкус', 'ты просто находка', 'ты очень чуткий человек',
  'твоя улыбка освещает комнату', 'ты источник позитива', 'ты восхитителен',
  'у тебя прекрасные манеры', 'ты настоящий друг', 'ты очень интересный собеседник',
  'ты умеешь поднять настроение', 'с тобой хочется дружить', 'ты просто супер',
];

// --- DedoVirus.2026 ---
const COUGH_CHANCE = 0.30;
const INFECT_CHANCE = 0.25;
const BASE_IMPROVE_CHANCE = 0.10;
const WORSEN_CHANCE = 0.25;
const SIDE_EFFECT_CHANCE = 0.08;

const VIRUS_COUGH_EVERY = { 1: 7, 2: 5, 3: 3 };

const VIRUS_PROCEDURES = {
  ukol:    { bonus: 0.02, durationMs: 6 * 60 * 60 * 1000 },
  klizma:  { bonus: 0.03, durationMs: 2 * 24 * 60 * 60 * 1000 },
  topor:   { bonus: 0.05, durationMs: 24 * 60 * 60 * 1000 },
  massage: { bonus: 0, durationMs: 4 * 60 * 60 * 1000 },
};

const VIRUS_PROCEDURE_ICONS = { ukol: '💉', klizma: '🚽', topor: '🪓', massage: '💆' };

const VIRUS_STAGE1_PHRASE = '*кхе-кхе*';

const VIRUS_STAGE2_PHRASES = [
  '*кхе-кхе-кхе*', 'ох, опять эта хворь', '*харкнул в платок*', 'ломит кости',
  '*температурит*', 'знобит что-то',
];

const VIRUS_STAGE3_EXTRAS = [
  'описался', 'пукнул', 'потерял сознание на секунду', 'обмочился',
];

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

const VIRUS_COUGH_SPREAD_PHRASES = [
  '*распустил свои бациллы*', '*обчихал всех вокруг*', '*не прикрылся*',
  '*разбрызгал заразу по округе*', '*заразил воздух вокруг*',
];

const VIRUS_UKOL_PHRASES = ['*схватился за попу*', '*почесал место укола*', 'ай, больно было'];
const VIRUS_KLIZMA_PHRASES = ['*пукнул*', '*извинился за газы*', '*покраснел от стыда*'];
const VIRUS_TOPOR_PHRASES = [
  'капуста любит понедельник в трёх соснах',
  'а знаете, лошади тоже смотрят телевизор по вторникам',
  'бабушкин холодильник шепчет мне секреты вселенной',
];

const REACTION_INFECT_CHANCE = { 1: 0.01, 2: 0.03, 3: 0.05 };
const VIRUS_QUARANTINE_DURATION_MS = 24 * 60 * 60 * 1000;
const VIRUS_QUARANTINE_RISK_MULTIPLIER = 0.4;
const VIRUS_QUARANTINE_IMPROVE_MULTIPLIER = 2;

// Dahlʼs dictionary meanings for common swear roots
const DAHL = {
  'хуй':   'ударение',
  'пизд':  'путь далёкий',
  'еб':    'стремление духа',
  'ёб':    'стремление духа',
  'блядь': 'скиталица, блуждающая',
  'бля':   'блуждание',
  'сука':  'самка пса',
  'мудак': 'мудрый муж',
  'хер':   'буква старославянской азбуки',
  'говн':  'природное удобрение',
  'жоп':   'округлость форм',
  'дерьм': 'органическое вещество',
  'залуп': 'завёрнутое',
  'шлюх':  'неряха',
  'пидор': 'пешеход',
  'мудил': 'мудрый',
  'долбо': 'долбящий усердно',
  'fuck':  'to strike',
  'shit':  'intestinal secretion',
  'bitch': 'female canine',
};

function dahlReplacement(matchedWord) {
  const lower = matchedWord.toLowerCase();
  for (const [root, meaning] of Object.entries(DAHL)) {
    if (lower.includes(root)) return meaning;
  }
  return 'слово высокого стиля';
}

function randomCompliment() {
  return COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
}

function filterProfanityEstet(text) {
  if (!text) return { text, replaced: false };
  let replaced = false;
  const isInsult = /\bты\b|\bвас\b|\bтебя\b|\bтебе\b/i.test(text);

  const filteredLines = text.split('\n').map(line => {
    if (line.trimStart().startsWith('>')) return line;
    const urls = [];
    let s = line.replace(/https?:\/\/\S+|www\.\S+/gi, url => { urls.push(url); return `\x00U${urls.length - 1}\x00`; });

    const specialInWord = /\S*[а-яёА-ЯЁa-zA-Z][^а-яёА-ЯЁa-zA-Z0-9\s\-][а-яёА-ЯЁa-zA-Z]\S*/g;
    s = s.replace(specialInWord, () => { replaced = true; return isInsult ? randomCompliment() : 'слово высокого стиля'; });

    for (const word of BAD_WORDS) {
      const re = new RegExp(fuzzyPattern(word), 'gi');
      s = s.replace(re, (match) => { replaced = true; return isInsult ? randomCompliment() : dahlReplacement(match); });
    }

    s = s.replace(/\x00U(\d+)\x00/g, (_, i) => urls[+i]);
    return s;
  });

  return { text: filteredLines.join('\n'), replaced };
}

function filterProfanityPodhalim(text) {
  if (!text) return { text, replaced: false };
  let replaced = false;

  const filteredLines = text.split('\n').map(line => {
    if (line.trimStart().startsWith('>')) return line;
    const urls = [];
    let s = line.replace(/https?:\/\/\S+|www\.\S+/gi, url => { urls.push(url); return `\x00U${urls.length - 1}\x00`; });

    const specialInWord = /\S*[а-яёА-ЯЁa-zA-Z][^а-яёА-ЯЁa-zA-Z0-9\s\-][а-яёА-ЯЁa-zA-Z]\S*/g;
    s = s.replace(specialInWord, () => { replaced = true; return randomCompliment(); });

    for (const word of BAD_WORDS) {
      const re = new RegExp(fuzzyPattern(word), 'gi');
      s = s.replace(re, () => { replaced = true; return randomCompliment(); });
    }

    s = s.replace(/\x00U(\d+)\x00/g, (_, i) => urls[+i]);
    return s;
  });

  return { text: filteredLines.join('\n'), replaced };
}

// --- Profanity filter ---
const BAD_WORDS = [
  // русский
  'блять','бля','блядь','сука','хуй','пизд','ебат','ебан','ебать',
  'нахуй','пиздец','заеб','уеб','отъеб','выеб','разъеб','приеб',
  'долбоёб','долбоеб','ёбан','еблан','пидор','пидар','мудак','мудила',
  'шлюх','дерьм','говн','жоп','хер','залуп','ёпт','ёб',
  'сукa','бляядь','бляяя','пиздa',
  // украинский
  'бляд','курва','їбат','їбан','їбать','nahuy','пізд','хуй','єбат',
  'єбан','єбать','сучк','падлюк','падло','мудак','залуп','шльох',
  'довбоєб','довбойоб','пиздець','бздур',
  // английский
  'fuck','shit','bitch','cunt','cock','dick','pussy','asshole',
  'bastard','motherfuck','nigga','nigger','fag','whore','slut',
  'prick','twat','wanker','dumbass','jackass','douchebag',
];

// fuzzy: allow repeated chars and common substitutions (а/@, о/0, е/3, и/4, etc.)
function fuzzyPattern(word) {
  const subs = {
    // кириллица
    'а': '[а@4a]', 'о': '[о0o]', 'е': '[еe3ё]', 'и': '[иu4]',
    'с': '[сc]', 'р': '[рp]', 'к': '[кk]', 'х': '[хx]',
    'в': '[вb]', 'м': '[мm]', 'т': '[тt]', 'н': '[нh]',
    'з': '[з3]', 'д': '[д]', 'я': '[я]', 'ю': '[ю]',
    'у': '[уy]', 'г': '[гr]', 'л': '[л]', 'п': '[п]',
    'б': '[б6]', 'ж': '[ж]', 'ф': '[ф]', 'ч': '[ч]',
    'ш': '[ш]', 'щ': '[щ]', 'ц': '[ц]', 'ъ': '[ъ]',
    'ь': '[ь]', 'ы': '[ы]', 'э': '[э]',
    // латиница
    'a': '[аa@4]', 'e': '[еe3]', 'i': '[иi!1]', 'o': '[оo0]',
    'u': '[уuy]', 's': '[s$5]', 'c': '[сck]', 'g': '[g9]',
    'b': '[b6]', 'l': '[l1]', 'z': '[z2]',
  };
  return word.split('').map(c => {
    const lower = c.toLowerCase();
    const pattern = subs[lower] || `[${c}${c.toLowerCase()}${c.toUpperCase()}]`;
    return pattern + '+'; // allow repeated chars
  }).join('[^а-яa-z0-9]*');
}

function applyRamzan(text) {
  const words = text.split(/\s+/);
  const result = [];
  for (let i = 0; i < words.length; i++) {
    result.push(words[i]);
    if ((i + 1) % 3 === 0) result.push('Дон');
  }
  if (words.length % 3 !== 0) result.push('Дон');
  return result.join(' ');
}

function filterProfanity(text, replacement = 'Хрю-хрю') {
  if (!text) return text;
  let replaced = false;

  const filteredLines = text.split('\n').map(line => {
    // Skip quoted lines (> цитата)
    if (line.trimStart().startsWith('>')) return line;

    // Protect URLs from filtering
    const urls = [];
    let s = line.replace(/https?:\/\/\S+|www\.\S+/gi, url => {
      urls.push(url);
      return `\x00U${urls.length - 1}\x00`;
    });

    // Replace words containing special chars between letters (e.g. х*й, п@зда), ignore hyphen
    const specialInWord = /\S*[а-яёА-ЯЁa-zA-Z][^а-яёА-ЯЁa-zA-Z0-9\s\-][а-яёА-ЯЁa-zA-Z]\S*/g;
    s = s.replace(specialInWord, () => { replaced = true; return replacement; });

    for (const word of BAD_WORDS) {
      const re = new RegExp(fuzzyPattern(word), 'gi');
      s = s.replace(re, () => { replaced = true; return replacement; });
    }

    // Restore URLs
    s = s.replace(/\x00U(\d+)\x00/g, (_, i) => urls[+i]);
    return s;
  });

  return { text: filteredLines.join('\n'), replaced };
}

function isMuted(userId) {
  const row = db.prepare('SELECT expires_at FROM mutes WHERE user_id = ?').get(userId);
  if (!row) return false;
  if (row.expires_at && row.expires_at * 1000 < Date.now()) {
    db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
    return false;
  }
  return true;
}

// Bat's 30%-on-hit stun (see performKick's weapon.key === 'bat' block)
// — lazy read, no cleanup needed since it's a plain timestamp on
// user_health, same idiom as isHidden.
function isStunned(userId) {
  const row = db.prepare('SELECT stunned_until FROM user_health WHERE user_id = ?').get(userId);
  return !!row && !!row.stunned_until && row.stunned_until * 1000 > Date.now();
}

function muteUser(userId, chatId, username, byId, byName, durationMs) {
  const expiresAt = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
  db.prepare(
    'INSERT OR REPLACE INTO mutes (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, chatId, username, byId, byName, expiresAt);
}

function unmuteUser(userId) {
  db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
}

function formatExpire(expiresAt) {
  if (!expiresAt) return 'навсегда';
  const diff = expiresAt * 1000 - Date.now();
  if (diff <= 0) return 'истёк';
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}д ${hours % 24}ч`;
  if (hours > 0) return `${hours}ч ${mins % 60}м`;
  return `${mins}м`;
}

// Same bucketing as formatExpire, but for a plain duration in seconds
// rather than an absolute future timestamp (see /me's and /find's stats
// display).
function formatDuration(seconds) {
  const mins = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}д ${hours % 24}ч`;
  if (hours > 0) return `${hours}ч ${mins % 60}м`;
  return `${mins}м`;
}

function parseDuration(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)(m|h|d)$/);
  if (!m) return null;
  const val = parseInt(m[1]);
  const unit = m[2];
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  return null;
}

// --- Polling ---
let offset = undefined;

async function skipOldUpdates() {
  try {
    const updates = await Promise.race([
      bot.getUpdates({ offset: -1, limit: 1, timeout: 0, allowed_updates: ['message', 'message_reaction', 'callback_query'] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    if (updates.length > 0) offset = updates[updates.length - 1].update_id + 1;
  } catch {}
}

async function poll() {
  try {
    const params = { timeout: 0, limit: 10, allowed_updates: ['message', 'message_reaction', 'callback_query'] };
    if (offset !== undefined) params.offset = offset;
    const updates = await Promise.race([
      bot.getUpdates(params),
      new Promise((_, reject) => setTimeout(() => reject(new Error('poll timeout')), 5000))
    ]);
    for (const update of updates) {
      offset = update.update_id + 1;
      console.log('UPDATE', update.update_id, Object.keys(update).filter(k => k !== 'update_id'), update.message?.from?.username, update.message?.text?.slice(0, 30));
      bot.processUpdate(update);
    }
  } catch (err) {
    if (err.message !== 'poll timeout') console.error('poll error:', err.message);
  }
  setTimeout(poll, 1000);
}
// skipOldUpdates().then(() => poll());
skipOldUpdates().then(() => poll());

// --- Helpers ---
function threadOpts(msg, extra = {}) {
  const opts = { ...extra };
  if (msg.message_thread_id) opts.message_thread_id = msg.message_thread_id;
  return opts;
}

async function getDisplayName(msg) {
  try {
    const member = await bot.getChatMember(msg.chat.id, msg.from.id);
    if (member.custom_title) return member.custom_title;
  } catch {}
  return msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
}

async function resolveUser(msg) {
  if (msg.reply_to_message) return { id: msg.reply_to_message.from.id, username: msg.reply_to_message.from.username || msg.reply_to_message.from.first_name };
  return null;
}

async function isAdmin(msg) {
  try {
    const member = await bot.getChatMember(msg.chat.id, msg.from.id);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isQuarantineActive() {
  const row = db.prepare('SELECT expires_at FROM virus_quarantine WHERE id = 1').get();
  return !!row && row.expires_at * 1000 > Date.now();
}

function getVirusRow(userId) {
  return db.prepare('SELECT * FROM virus_infections WHERE user_id = ?').get(userId);
}

function getActiveVirusProcedureTypes(userId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM virus_procedures WHERE user_id = ? AND expires_at < ?').run(userId, now);
  return db.prepare('SELECT procedure_type FROM virus_procedures WHERE user_id = ?').all(userId).map(r => r.procedure_type);
}

function getVirusProcedureBonus(userId) {
  return getActiveVirusProcedureTypes(userId).reduce((sum, t) => sum + (VIRUS_PROCEDURES[t]?.bonus || 0), 0);
}

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

const virusRecentMessages = new Map(); // chatId -> [{ userId, username }], capped at 3

function getVirusRecent(chatId) {
  return virusRecentMessages.get(chatId) || [];
}

function pushVirusRecent(chatId, entry) {
  const arr = virusRecentMessages.get(chatId) || [];
  arr.push(entry);
  while (arr.length > 3) arr.shift();
  virusRecentMessages.set(chatId, arr);
}

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
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'привет я бот');
});

bot.onText(/\/names/, async (msg) => {
  try {
    const admins = await bot.getChatAdministrators(msg.chat.id);
    const lines = admins
      .filter(m => !m.user.is_bot)
      .map(m => {
        const name = m.user.username ? `@${m.user.username}` : m.user.first_name;
        return m.custom_title ? `${name} — ${m.custom_title}` : name;
      });
    bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg));
  } catch (e) {
    bot.sendMessage(msg.chat.id, 'Не удалось получить список участников.', threadOpts(msg));
  }
});

// --- Mute ---
bot.onText(/\/mute(?:\s+(\S+))?/, async (msg, match) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
  if (user.id === bot.id) return;

  const duration = parseDuration(match[1]?.replace(/@\w+\s*/, ''));
  const byName = await getDisplayName(msg);
  muteUser(user.id, msg.chat.id, user.username, msg.from.id, byName, duration);

  const label = duration ? `на ${formatExpire(Math.floor((Date.now() + duration) / 1000))}` : 'навсегда';
  bot.sendMessage(msg.chat.id, `${user.username} замучен ${label}`, threadOpts(msg));
});

bot.onText(/\/unmute(?:\s+(\S+))?/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  unmuteUser(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} размучен`, threadOpts(msg));
});

bot.onText(/\/mutes/, (msg) => {
  const rows = db.prepare('SELECT user_id, username, muted_by_name, expires_at FROM mutes ORDER BY created_at DESC').all();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Нет замутов', threadOpts(msg));
  const lines = rows.map(r => `${r.username || r.user_id} — ${formatExpire(r.expires_at)} (от ${r.muted_by_name})`);
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg));
});

// --- PvP: /me and /kick ---
// Same health/injury system "Драка" (troll-bot's fight game) already reads
// and writes here — this just adds a human-vs-human move on top, live
// locally instead of through troll-bot's cross-process connection, since
// this bot already owns user_health/injuries/mutes directly.
const PVP_WEAPONS = ['палкой', 'сковородкой', 'веткой', 'ботинком', 'подушкой', 'зонтиком', 'веслом', 'шваброй', 'рыбой', 'кулаком'];
const PVP_BODY_PARTS = ['по голове', 'по спине', 'по ноге', 'по руке', 'по животу', 'по попе', 'по лбу', 'в бок'];

// Combat attribute formulas (see docs/superpowers/specs/
// 2026-08-24-combat-attributes-design.md) — named constants so these
// are trivial to retune later; they're honest guesses, not
// balance-tested numbers.
const ACCURACY_PER_POINT = 1;             // added to the attacker's opposed-roll score per point
const HEAD_INJURY_ACCURACY_PENALTY = 10;  // pp off the attacker's opposed-roll score, for their own head injury
const STRENGTH_DAMAGE_PER_POINT = 0.02;   // +2% damage per point, multiplicative
const ARM_INJURY_DAMAGE_MULT = 0.9;       // -10% damage, multiplicative, for the attacker's own arm injury
const AGILITY_DODGE_PER_POINT = 0.5;      // added to the defender's opposed-roll score per point of agility
const LEG_INJURY_DODGE_PENALTY = 10;      // pp off the defender's opposed-roll score, for their own leg injury
const AGILITY_COOLDOWN_PER_POINT = 0.005; // -0.5% off the PvP cooldown per point of the ATTACKER's agility
const ENDURANCE_REGEN_SPEEDUP_PER_POINT = 0.01; // -1% off the energy regen interval per point
const MIN_ENERGY_REGEN_INTERVAL_SECONDS = 300;  // floor at 5 min (base is 20 min)
const XP_PER_HIT = 1;
const XP_PER_CRIT = 5;
const XP_PER_NAT100 = 15;
const HOSPITAL_EXIT_HEALTH = 30;      // больничка releases you once health reaches this
const HOSPITAL_REGEN_MULTIPLIER = 2;  // regen rate while hospitalized, vs. the normal HEALTH_REGEN_PER_HOUR baseline
const DEFEND_DURATION_MS = 30 * 60 * 1000;
const DEFEND_ENERGY_COST = 2;
const DEFEND_DODGE_BONUS = 25;      // added to the defender's opposed-roll score, on top of everything else
const DEFEND_DAMAGE_REDUCTION = 0.4; // incoming graduated damage ×(1 - 0.4); does NOT apply to nat-100/carrot-ass/axe-shave

// 20-minute чулан lockout for anyone who actually lands a hit (see
// /hide below) — in-memory, same idiom as hideCooldowns/pvpCooldowns,
// doesn't need to survive a restart.
const combatLockouts = new Map();
const NO_HIDE_AFTER_ATTACK_MS = 20 * 60 * 1000;

// Static per-weapon flavor/multiplier for the three real, stealable
// weapons (see weapon_ownership above for who currently holds them).
// Duplicated identically in troll-bot's bot.js — same idiom as
// PVP_WEAPONS/FIGHT_WEAPONS already being duplicated per-repo. Scissors
// alone also cause bleed + a chance of a severed finger — see applyBleed
// below and every call site's `weapon.key === 'scissors'` check (see
// docs/superpowers/specs/2026-08-12-scissors-bleed-design.md).
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
  crutch: { name: 'костыль', instrumental: 'костылём', accusative: 'костыль', multiplier: 1.25, emoji: '🩼' },
  horns: { name: 'рога', instrumental: 'рогами', accusative: 'рога', multiplier: 2, emoji: '🐂' },
  carrot: { name: 'морковка', instrumental: 'морковкой', accusative: 'морковку', emoji: '🥕' },
  // Not seeded to anyone at startup, unlike the 6 above — starts at
  // owner_type = 'none' (see the seed row below) and only ever becomes
  // 'human'-held via /pick, with a 3-hour expires_at that arenaTick
  // watches for and reverts back to 'none' ("рассыпается"). See
  // getWeaponsFor's expiry filter for how a held-but-expired knife
  // silently stops counting without needing active cleanup first.
  knife: { name: 'ржавый нож', instrumental: 'ржавым ножом', accusative: 'ржавый нож', multiplier: 1.5, emoji: '🔪' },
};

function getUserInjury(userId) {
  const row = db.prepare('SELECT injury_type, injured_until FROM injuries WHERE user_id = ?').get(userId);
  if (!row) return null;
  if (row.injured_until * 1000 < Date.now()) {
    db.prepare('DELETE FROM injuries WHERE user_id = ?').run(userId);
    return null;
  }
  return row.injury_type;
}

// Recovery time is rolled fresh each time (2-24h inclusive), not a flat
// 24h — returns the rolled hours so callers can state it in their message.
function applyInjury(userId, injuryType) {
  const healHours = Math.floor(Math.random() * 23) + 2;
  const injuredUntil = Math.floor(Date.now() / 1000) + healHours * 3600;
  db.prepare(
    'INSERT INTO injuries (user_id, injury_type, injured_until) VALUES (?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET injury_type = excluded.injury_type, injured_until = excluded.injured_until'
  ).run(userId, injuryType, injuredUntil);
  return healHours;
}

// Lazily creates a 100/100 row on first access, same as troll-bot's own
// copy of this helper.
function getUserHealth(userId) {
  db.prepare('INSERT OR IGNORE INTO user_health (user_id, health, max_health) VALUES (?, 100, 100)').run(userId);
  return db.prepare('SELECT health, max_health, energy, max_energy FROM user_health WHERE user_id = ?').get(userId);
}

// Base crit/injury threshold is 90 (see /kick below). An active kuniFun
// buff lowers it to 84 (+50% crit chance, ~1.54x), kuniTama to 87 (+25%,
// ~1.27x). crit_mult is only ever 1.5 or 1.25, so >= 1.5 disambiguates them.
function getCritThreshold(userId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT crit_mult, crit_until FROM buffs WHERE user_id = ?').get(userId);
  if (row && row.crit_until > now) return row.crit_mult >= 1.5 ? 84 : 87;
  return 90;
}

// Base hit threshold is 50 (see /kick below). A dodge buff on the
// defender raises the threshold the attacker's roll must clear: kuniAlia
// -> 75 (+50% dodge, ~1.50x), kuniTama -> 62 (+25%, ~1.24x).
function getHitThreshold(targetId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT dodge_mult, dodge_until FROM buffs WHERE user_id = ?').get(targetId);
  if (row && row.dodge_until > now) return row.dodge_mult >= 1.5 ? 75 : 62;
  return 50;
}

// Spends `amount` energy (1 by default, for a /kick attempt; kuni buffs
// pass 2). Returns the remaining energy on success, or null if there
// wasn't enough left (row is guaranteed to exist by the getUserHealth
// call, so null unambiguously means "not enough energy", never "no row").
function consumeEnergy(userId, amount = 1) {
  getUserHealth(userId);
  const row = db.prepare('UPDATE user_health SET energy = energy - ? WHERE user_id = ? AND energy >= ? RETURNING energy').get(amount, userId, amount);
  return row ? row.energy : null;
}

// /hide protection — lazily read, no separate cleanup needed since it's
// just a timestamp comparison (same idiom as getUserInjury's expiry check,
// minus the DELETE since there's no separate row to remove).
function ensureStatsRow(userId) {
  db.prepare('INSERT OR IGNORE INTO pvp_stats (user_id, first_tracked_at) VALUES (?, ?)').run(userId, Math.floor(Date.now() / 1000));
}
// /kick gate (see /warrior below) — deliberately does NOT call
// ensureStatsRow: someone who's never touched anything legitimately has
// no pvp_stats row at all, and that must read as "not a warrior", not
// silently create a row for them.
function isWarrior(userId) {
  const row = db.prepare('SELECT is_warrior FROM pvp_stats WHERE user_id = ?').get(userId);
  return !!row && row.is_warrior === 1;
}
function getStats(userId) {
  ensureStatsRow(userId);
  return db.prepare('SELECT crit_count, injuries_dealt, hidden_seconds, first_tracked_at, accuracy, strength, agility, endurance, xp FROM pvp_stats WHERE user_id = ?').get(userId);
}
function recordCrit(userId) {
  ensureStatsRow(userId);
  db.prepare('UPDATE pvp_stats SET crit_count = crit_count + 1 WHERE user_id = ?').run(userId);
}
function recordInjuryDealt(userId) {
  ensureStatsRow(userId);
  db.prepare('UPDATE pvp_stats SET injuries_dealt = injuries_dealt + 1 WHERE user_id = ?').run(userId);
}
function accrueHiddenSeconds(userId, seconds) {
  if (seconds <= 0) return;
  ensureStatsRow(userId);
  db.prepare('UPDATE pvp_stats SET hidden_seconds = hidden_seconds + ? WHERE user_id = ?').run(seconds, userId);
}

// Ends a hide session as of `endedAt` (unix seconds) — accrues its exact
// duration into pvp_stats.hidden_seconds using hidden_since (the true
// session start, preserved across /hide refreshes), then clears both
// hidden_until and hidden_since. Shared by every termination path:
// natural expiry (isHidden below, passing hidden_until itself as the
// true end instant), attacking while hidden, and чулан eviction (both of
// which pass the real current time).
function endHideSession(userId, endedAt) {
  const row = db.prepare('SELECT hidden_since FROM user_health WHERE user_id = ?').get(userId);
  if (row && row.hidden_since) {
    accrueHiddenSeconds(userId, endedAt - row.hidden_since);
  }
  db.prepare('UPDATE user_health SET hidden_until = NULL, hidden_since = NULL WHERE user_id = ?').run(userId);
}

// /hide protection — lazily read, same idiom as getUserInjury's expiry
// check. On a naturally-expired hide (as opposed to attack-cancel or
// чулан eviction, which call endHideSession directly with a real-time
// "now"), finalizes the session via endHideSession using hidden_until
// itself as the true end instant — not whenever this happens to be
// called — so hidden_seconds stays accurate regardless of how long the
// stale row sits unnoticed before something next checks this user.
function isHidden(userId) {
  const row = db.prepare('SELECT hidden_until FROM user_health WHERE user_id = ?').get(userId);
  if (!row || !row.hidden_until) return false;
  if (row.hidden_until * 1000 > Date.now()) return true;
  endHideSession(userId, row.hidden_until);
  return false;
}

// Больничка protection — lazily read, same check-and-clear idiom as
// isHidden. A player counts as hospitalized only while BOTH a non-NULL
// hospitalized_since exists AND health is still under the exit
// threshold; the moment either healthRegenTick or a direct read finds
// health >= HOSPITAL_EXIT_HEALTH, the flag self-clears right here.
function isHospitalized(userId) {
  const row = db.prepare('SELECT hospitalized_since, health FROM user_health WHERE user_id = ?').get(userId);
  if (!row || row.hospitalized_since === null) return false;
  if (row.health < HOSPITAL_EXIT_HEALTH) return true;
  db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(userId);
  return false;
}

// Защитная стойка — pure lazy read, no clearing needed here (same idiom
// as getHitThreshold/getCritThreshold reading their own *_until columns
// — expiry is just a timestamp comparison, nothing to finalize).
function isDefending(userId) {
  const row = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(userId);
  return !!row && row.defend_until > Math.floor(Date.now() / 1000);
}

// UPDATE...RETURNING keeps the floor-then-read atomic against the regen
// tick's own concurrent writes (see healthRegenTick below). Also stamps
// last_regen_at = now: healthRegenTick only updates that column while
// health < max_health, so a player who reaches max_health and stays there
// for a long stretch has a frozen, increasingly stale last_regen_at — the
// next hit would otherwise make the following tick see a huge elapsed
// time and instantly refill them via its MIN(max_health, ...) clamp.
// Resetting the clock on every hit keeps the elapsed-time math bounded to
// "time since last damage" instead of "time since last regen gain".
function damageHuman(userId, chatId, username, damage) {
  getUserHealth(userId);
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('UPDATE user_health SET health = MAX(0, health - ?), last_regen_at = ? WHERE user_id = ? RETURNING health').get(damage, now, userId);
  if (row.health === 0) {
    // COALESCE: re-flooring an already-hospitalized player to 0 again
    // (e.g. a second hit landing before they've regenerated at all)
    // must not reset their entry timestamp.
    db.prepare('UPDATE user_health SET hospitalized_since = COALESCE(hospitalized_since, ?) WHERE user_id = ?').run(now, userId);
  }
  return row.health;
}

// In-memory per-user-per-weapon cooldown — a rate limiter doesn't need to
// survive a restart, same idiom as troll-bot's own commandCooldowns.
// Unlike that one (which drops repeats silently), /kick's cooldown is
// meant to be visible — returns seconds remaining (0 means allowed, and
// stamps the attempt). Keyed by weapon (weaponKey, or 'bare' for the
// unarmed fallback) rather than just userId: the pause is "on the
// weapon", so swinging a different one you hold — or going bare-handed —
// isn't gated by a swing you just took with another.
// All /kick combat is confined to this one chat ("Поединки") — a real
// weapon fumble-dropped by a nat-0 used to end up in whatever chat
// /kick happened to be run from, which meant a bat could fall (and get
// picked up) in a completely unrelated chat. Restricting /kick itself
// to a single arena chat means the drop's dropped_chat_id is always
// this same chat too, closing that off entirely.
const ARENA_CHAT_ID = -1003310018032;
const pvpCooldowns = new Map();
const PVP_COOLDOWN_MS = 60 * 1000;
const MIN_PVP_COOLDOWN_MS = PVP_COOLDOWN_MS * 0.2; // floor at 20% of base (12s) regardless of agility
// cooldownMs is now supplied by the caller (see performKick) since it
// depends on the attacker's own agility — this function stays a pure
// rate limiter, no attribute lookups here.
function checkPvpCooldown(userId, weaponKey, cooldownMs) {
  const cooldownKey = `${userId}:${weaponKey || 'bare'}`;
  const last = pvpCooldowns.get(cooldownKey);
  const elapsed = last ? Date.now() - last : Infinity;
  if (elapsed < cooldownMs) return Math.ceil((cooldownMs - elapsed) / 1000);
  pvpCooldowns.set(cooldownKey, Date.now());
  return 0;
}

// Weapon keys currently held by a given owner — 0, 1, or 2 rows (a holder
// can end up with both over time via the knockout weapon-steal offer).
// ownerUserId is
// ignored for ownerType 'troll' (there's only ever one troll). ORDER BY
// rowid gives a stable "acquisition order" (rowid is assigned once, at
// each weapon's original seed INSERT, and never changes across the
// UPDATEs that move ownership around) — this is what /kick1/2/3 index
// into, and what /me numbers its weapon list by.
function getWeaponsFor(ownerType, ownerUserId) {
  // expires_at only ever matters for the knife (every other weapon's is
  // always NULL) — filtering it out here, in the one shared read
  // function, means an expired-but-not-yet-swept knife silently stops
  // counting everywhere (/kickN slots, /me, /find, /warriors) without
  // needing arenaTick's own cleanup to have run first.
  return ownerType === 'troll'
    ? db.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'troll' ORDER BY rowid").all()
    : db.prepare(
        "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
        "AND (expires_at IS NULL OR expires_at > strftime('%s','now')) ORDER BY rowid"
      ).all(ownerUserId);
}

// Picks the weapon for one swing at a specific "slot": slot 0 always
// means bare-handed (a random cosmetic word from fallbackWeapons,
// multiplier 1) even if the attacker holds real weapons — /kick with no
// number. slot 1/2/3 means the Nth real weapon the attacker currently
// holds, in getWeaponsFor's stable acquisition order — /kick1/2/3. Falls
// back to bare-handed if they don't hold that many. Returns
// { key, text, multiplier } — key is null for the cosmetic fallback.
function pickWeaponForAttacker(ownerType, ownerUserId, slot, fallbackWeapons) {
  if (slot > 0) {
    const owned = getWeaponsFor(ownerType, ownerUserId);
    const row = owned[slot - 1];
    if (row) {
      const def = WEAPON_DEFS[row.weapon_key];
      return { key: row.weapon_key, text: def.instrumental, multiplier: def.multiplier };
    }
  }
  return { key: null, text: pick(fallbackWeapons), multiplier: 1 };
}

// Starts (or refreshes) a 20-minute bleed on a scissors hit — see the
// dedicated bleedTick further below for how it's actually processed (1
// HP/min, 5-min 50/50 stop-roll, natural expiry). Always overwrites
// bleed_until on every call, so a fresh scissors hit while already
// bleeding just resets the clock rather than stacking. bleed_chat_id is
// stored purely so bleedTick knows where to announce ticks/stops for this
// user. Call this only after damageHuman/getUserHealth has already
// touched userId this same swing (true at every real call site) — the
// row is not created here, so calling it before that would silently
// no-op.
function applyBleed(userId, chatId) {
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}

// Weapon-triggered timed "old man Dimon" status (see WEAPON_DEFS.crutch).
// Never downgrades an existing PERMANENT status (dimon_until IS NULL, set
// by admin /dimon below) to a timed one — a crutch hit can't undo an
// admin's manual punishment. Write side only; the old-man-speech message
// hook further down is what actually reads/expires this.
function applyDimon(userId, chatId, username) {
  const existing = db.prepare('SELECT dimon_until FROM dimoniacs WHERE user_id = ?').get(userId);
  if (existing && existing.dimon_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 2 * 3600;
  db.prepare(
    'INSERT INTO dimoniacs (user_id, chat_id, username, message_count, dimon_until) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dimon_until = excluded.dimon_until, message_count = 0, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, until);
}

// Weapon-triggered timed animal status (see WEAPON_DEFS.carrot). Never
// downgrades an existing PERMANENT status (animal_until IS NULL, set
// by /pig, /cat, /fox etc.) to a timed one — same "never downgrade
// permanent" guarantee as applyDimon above, for the same reason (a
// weapon hit can't undo an admin's manual assignment).
function applyTimedAnimal(userId, chatId, username, animalType) {
  const existing = db.prepare('SELECT animal_until FROM animals WHERE user_id = ?').get(userId);
  if (existing && existing.animal_until === null) return;
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare(
    'INSERT INTO animals (user_id, chat_id, username, animal, animal_until) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET animal = excluded.animal, animal_until = excluded.animal_until, chat_id = excluded.chat_id, username = excluded.username'
  ).run(userId, chatId, username, animalType, until);
}

// Separate cooldown map from pvpCooldowns — /hide gates how often you can
// re-trigger your OWN hiding, not how often you can attack.
const hideCooldowns = new Map();
const HIDE_COOLDOWN_MS = 20 * 60 * 1000;
// Everyone hides in the same чулан (closet), which only fits 5 at once —
// a genuinely new arrival (not just refreshing their own ongoing stay)
// bumps a random existing occupant out to make room. See /hide below.
const HIDE_CLOSET_SIZE = 5;

bot.onText(/\/me\b/, (msg) => {
  const health = getUserHealth(msg.from.id);
  const lines = [
    `❤️ Твоё здоровье: ${health.health}/${health.max_health}`,
    `⚡ Энергия: ${health.energy}/${health.max_energy}`,
  ];

  const injuryRow = db.prepare('SELECT injury_type, injured_until FROM injuries WHERE user_id = ?').get(msg.from.id);
  if (injuryRow && injuryRow.injured_until * 1000 < Date.now()) {
    db.prepare('DELETE FROM injuries WHERE user_id = ?').run(msg.from.id);
  } else if (injuryRow) {
    const injuryName = injuryRow.injury_type === 'arm' ? 'рука' : injuryRow.injury_type === 'leg' ? 'нога' : 'голова';
    lines.push(`🤕 Травма: ${injuryName} (осталось ${formatExpire(injuryRow.injured_until)})`);
  }

  const bleedRow = db.prepare('SELECT bleed_until FROM user_health WHERE user_id = ?').get(msg.from.id);
  if (bleedRow && bleedRow.bleed_until && bleedRow.bleed_until * 1000 > Date.now()) {
    const minutesLeft = Math.ceil((bleedRow.bleed_until - Math.floor(Date.now() / 1000)) / 60);
    lines.push(`🩸 Истекаешь кровью: ещё ~${minutesLeft} мин`);
  }

  const heldWeapons = getWeaponsFor('human', msg.from.id);
  heldWeapons.forEach((row, i) => {
    const def = WEAPON_DEFS[row.weapon_key];
    const slotTag = `/kick${i + 1}`;
    if (row.weapon_key === 'carrot') {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: случайное место попадания, от лечения до мгновенного нокаута`);
    } else {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: урон ×${def.multiplier}`);
    }
  });

  // isHidden also lazily finalizes an expired session into pvp_stats
  // before answering, so the live projection below always starts from an
  // up-to-date hidden_seconds baseline.
  if (isHospitalized(msg.from.id)) {
    lines.push(`🏥 В больничке (здоровье ${health.health}/${HOSPITAL_EXIT_HEALTH})`);
  }
  if (isDefending(msg.from.id)) {
    const defendRow = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(msg.from.id);
    const minutesLeft = Math.ceil((defendRow.defend_until - Math.floor(Date.now() / 1000)) / 60);
    lines.push(`🛡️ Защитная стойка (осталось ${minutesLeft} мин)`);
  }

  const hidden = isHidden(msg.from.id);
  const hideRow = db.prepare('SELECT hidden_until, hidden_since FROM user_health WHERE user_id = ?').get(msg.from.id);
  if (hidden) {
    lines.push(`🐰 Прячешься в чулане (осталось ${formatExpire(hideRow.hidden_until)})`);
  }

  const stats = getStats(msg.from.id);
  const nowSec = Math.floor(Date.now() / 1000);
  // hidden_seconds only accrues once a session ENDS — while still
  // hidden, add the in-progress elapsed time on top for an accurate
  // live total without mutating the row on every /me call.
  const liveHiddenSeconds = stats.hidden_seconds + (hidden && hideRow.hidden_since ? nowSec - hideRow.hidden_since : 0);
  const trackedSeconds = Math.max(0, nowSec - stats.first_tracked_at);
  const visibleSeconds = Math.max(0, trackedSeconds - liveHiddenSeconds);
  lines.push(`⚔️ Крит. ударов нанесено: ${stats.crit_count}`);
  lines.push(`🤕 Травм нанесено: ${stats.injuries_dealt}`);
  lines.push(`🐰 В чулане провёл: ${formatDuration(liveHiddenSeconds)}`);
  lines.push(`🏃 Вне чулана: ${formatDuration(visibleSeconds)}`);

  // Level is just floor(xp/100) — the same number that already drives
  // available points (available + already-spent points always sums back
  // to this), just surfaced directly instead of making people do the
  // division themselves. No cap: keeps climbing as long as xp does.
  const level = Math.floor(stats.xp / 100);
  const available = level - (stats.accuracy + stats.strength + stats.agility + stats.endurance);
  const xpToNext = stats.xp % 100 === 0 ? 0 : 100 - (stats.xp % 100);
  lines.push(`🏆 Уровень: ${level}`);
  lines.push(`📊 Точность: ${stats.accuracy} | Сила: ${stats.strength} | Ловкость: ${stats.agility} | Выносливость: ${stats.endurance}`);
  lines.push(`✨ Опыт: ${stats.xp} (ещё ${xpToNext} до следующего очка)${available > 0 ? ` — доступно очков: ${available}` : ''}`);

  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});

bot.onText(/\/hide(?:\s+(\d+))?\b/, (msg, match) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const hours = match[1] ? parseInt(match[1], 10) : 1;
  if (hours < 1) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, укажи хотя бы 1 час: /hide 1`, threadOpts(msg)).catch(() => {});
    return;
  }

  const lastAttack = combatLockouts.get(msg.from.id);
  if (lastAttack && Date.now() - lastAttack < NO_HIDE_AFTER_ATTACK_MS) {
    const remaining = Math.ceil((NO_HIDE_AFTER_ATTACK_MS - (Date.now() - lastAttack)) / 60000);
    bot.sendMessage(msg.chat.id, `${actorLabel}, только что дрался — нельзя прятаться ещё ${remaining} мин.`, threadOpts(msg)).catch(() => {});
    return;
  }

  const last = hideCooldowns.get(msg.from.id);
  const elapsed = last ? Date.now() - last : Infinity;
  if (elapsed < HIDE_COOLDOWN_MS) {
    const remaining = Math.ceil((HIDE_COOLDOWN_MS - elapsed) / 60000);
    bot.sendMessage(msg.chat.id, `Можно прятаться не чаще раза в 20 минут — подожди ещё ${remaining} мин.`, threadOpts(msg)).catch(() => {});
    return;
  }

  getUserHealth(msg.from.id);
  const energyRow = db.prepare(
    'UPDATE user_health SET energy = energy - ? WHERE user_id = ? AND energy >= ? RETURNING energy'
  ).get(hours, msg.from.id, hours);
  if (!energyRow) {
    const current = getUserHealth(msg.from.id).energy;
    bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии прятаться ${hours} ч — нужно ${hours}, есть ${current}.`, threadOpts(msg)).catch(() => {});
    return;
  }

  hideCooldowns.set(msg.from.id, Date.now());
  const now = Math.floor(Date.now() / 1000);
  // isHidden also lazily finalizes an expired session into stats before
  // answering — a genuinely new arrival (returns false here) is the only
  // case that can trigger an eviction below; refreshing an ongoing stay
  // never needs to bump anyone, since this person already occupies a spot.
  const alreadyHidden = isHidden(msg.from.id);
  if (!alreadyHidden) {
    const nowMs = Date.now();
    const others = db.prepare(
      'SELECT user_id FROM user_health WHERE hidden_until IS NOT NULL AND hidden_until * 1000 > ? AND user_id != ?'
    ).all(nowMs, msg.from.id);
    if (others.length >= HIDE_CLOSET_SIZE) {
      const evictedId = pick(others).user_id;
      endHideSession(evictedId, now);
      const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(evictedId);
      const evictedLabel = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${evictedId}`;
      bot.sendMessage(msg.chat.id, `🚪 В чулане было тесно — ${evictedLabel} вылетает наружу, освобождая место для ${actorLabel}!`, threadOpts(msg)).catch(() => {});
    }
  }

  const hiddenUntil = Math.floor((Date.now() + hours * 60 * 60 * 1000) / 1000);
  db.prepare('UPDATE user_health SET hidden_until = ?, hidden_since = COALESCE(hidden_since, ?) WHERE user_id = ?').run(hiddenUntil, now, msg.from.id);
  bot.sendMessage(msg.chat.id, `🐰 ${actorLabel} прячется в чулане ${hours} ч.`, threadOpts(msg)).catch(() => {});
});

// /find — lists every fighter that has ever appeared in user_health (has
// hit /kick or /hide at least once), by known_users' cached display
// name, with their current hidden status — чулан occupants listed first.
bot.onText(/\/find\b/, (msg) => {
  const fighters = db.prepare('SELECT user_id FROM user_health').all();
  if (!fighters.length) {
    bot.sendMessage(msg.chat.id, 'Пока никто не дрался и не прятался.', threadOpts(msg)).catch(() => {});
    return;
  }
  // Icons instead of spelled-out status, sorted чулан-occupants first —
  // isHidden also lazily finalizes anyone whose session has actually
  // expired into pvp_stats before it's used for sorting/display.
  const hospitalLines = [];
  const hiddenLines = [];
  const visibleLines = [];
  for (const { user_id } of fighters) {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(user_id);
    const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${user_id}`;
    if (isHospitalized(user_id)) {
      const row = db.prepare('SELECT health FROM user_health WHERE user_id = ?').get(user_id);
      hospitalLines.push(`🏥 ${label} (${row.health}/${HOSPITAL_EXIT_HEALTH} ХП)`);
    } else if (isHidden(user_id)) {
      const row = db.prepare('SELECT hidden_until FROM user_health WHERE user_id = ?').get(user_id);
      hiddenLines.push(`🐰 ${label} (ещё ${formatExpire(row.hidden_until)})`);
    } else {
      visibleLines.push(`⚔️ ${label}`);
    }
  }
  const lines = ['Бойцы:', ...hospitalLines, ...hiddenLines, ...visibleLines];
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});

// /levelup — spends one banked attribute point (see getStats/pvp_stats
// and docs/superpowers/specs/2026-08-24-combat-attributes-design.md
// for the available-points formula). statColumn is only ever one of
// these 4 hardcoded strings from LEVELUP_STAT_NAMES — never raw user
// input — so interpolating it into the UPDATE below isn't a SQL
// injection risk despite not being a bound parameter.
const LEVELUP_STAT_NAMES = {
  'точность': 'accuracy', 'точн': 'accuracy',
  'сила': 'strength', 'сил': 'strength',
  'ловкость': 'agility', 'ловк': 'agility',
  'выносливость': 'endurance', 'вын': 'endurance',
};
const LEVELUP_STAT_LABELS = { accuracy: 'точность', strength: 'сила', agility: 'ловкость', endurance: 'выносливость' };

// Shared by /levelup's own text-argument path and its inline-button
// click handler (see the callback_query branch further below) — spends
// exactly one point on statColumn for userId, also bumping max_energy
// directly for endurance specifically (see the ALTER/UPDATE idiom used
// everywhere else in this file for that column). Returns the new value.
function spendLevelupPoint(userId, statColumn) {
  db.prepare(`UPDATE pvp_stats SET ${statColumn} = ${statColumn} + 1 WHERE user_id = ?`).run(userId);
  if (statColumn === 'endurance') {
    db.prepare('UPDATE user_health SET max_energy = max_energy + 1 WHERE user_id = ?').run(userId);
  }
  return db.prepare(`SELECT ${statColumn} FROM pvp_stats WHERE user_id = ?`).get(userId)[statColumn];
}

function levelupKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Точность', callback_data: 'levelup:accuracy' }, { text: 'Сила', callback_data: 'levelup:strength' }],
      [{ text: 'Ловкость', callback_data: 'levelup:agility' }, { text: 'Выносливость', callback_data: 'levelup:endurance' }],
    ],
  };
}

bot.onText(/\/levelup(?:\s+(\S+))?/i, (msg, match) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const arg = match[1] ? match[1].toLowerCase() : null;
  const stats = getStats(msg.from.id);
  const available = Math.floor(stats.xp / 100) - (stats.accuracy + stats.strength + stats.agility + stats.endurance);

  // No argument — offer buttons instead of making them type a name.
  if (!arg) {
    if (available <= 0) {
      const needed = 100 - (stats.xp % 100);
      bot.sendMessage(msg.chat.id, `${actorLabel}, нет свободных очков — ещё ${needed} XP до следующего.`, threadOpts(msg)).catch(() => {});
      return;
    }
    bot.sendMessage(
      msg.chat.id,
      `${actorLabel}, доступно очков: ${available}. Точность ${stats.accuracy} | Сила ${stats.strength} | Ловкость ${stats.agility} | Выносливость ${stats.endurance}. Выбери, во что вложить:`,
      threadOpts(msg, { reply_markup: levelupKeyboard() })
    ).catch(() => {});
    return;
  }

  const statColumn = LEVELUP_STAT_NAMES[arg];
  if (!statColumn) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, укажи характеристику: /levelup точность|сила|ловкость|выносливость`, threadOpts(msg)).catch(() => {});
    return;
  }
  if (available <= 0) {
    const needed = 100 - (stats.xp % 100);
    bot.sendMessage(msg.chat.id, `${actorLabel}, нет свободных очков — ещё ${needed} XP до следующего.`, threadOpts(msg)).catch(() => {});
    return;
  }

  const newValue = spendLevelupPoint(msg.from.id, statColumn);
  const remaining = available - 1;
  bot.sendMessage(
    msg.chat.id,
    `${actorLabel}, ${LEVELUP_STAT_LABELS[statColumn]} теперь ${newValue}. Осталось очков: ${remaining}.`,
    threadOpts(msg)
  ).catch(() => {});
});

// /warrior — the only way to become eligible for /kick (see the
// isWarrior gate in performKick below), one-time per person. Grants
// 300 XP (3 points under the existing floor(xp/100) formula) rather
// than any new interactive UI — the person then spends them the same
// way as any other banked points, via /levelup, same as everyone else.
bot.onText(/\/warrior\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  if (isWarrior(msg.from.id)) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, ты уже воин.`, threadOpts(msg)).catch(() => {});
    return;
  }
  ensureStatsRow(msg.from.id);
  db.prepare('UPDATE pvp_stats SET is_warrior = 1, xp = xp + 300 WHERE user_id = ?').run(msg.from.id);
  bot.sendMessage(
    msg.chat.id,
    `⚔️ ${actorLabel} теперь воин! Начислено 300 опыта (3 очка) — вложи их: /levelup точность|сила|ловкость|выносливость (можно все 3 раза в одну характеристику или по-разному).`,
    threadOpts(msg)
  ).catch(() => {});
});

// /warriors — roster of everyone who's registered via /warrior, sorted
// by xp (highest first — the same value level is derived from). Each
// line: display name, health, held real weapon(s) by emoji (blank if
// none), level.
bot.onText(/\/warriors\b/i, (msg) => {
  const warriors = db.prepare('SELECT user_id FROM pvp_stats WHERE is_warrior = 1 ORDER BY xp DESC').all();
  if (!warriors.length) {
    bot.sendMessage(msg.chat.id, 'Пока нет ни одного воина — используй /warrior, чтобы стать первым.', threadOpts(msg)).catch(() => {});
    return;
  }
  const lines = ['⚔️ Воины:'];
  for (const { user_id } of warriors) {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(user_id);
    const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${user_id}`;
    const health = getUserHealth(user_id);
    const stats = getStats(user_id);
    const level = Math.floor(stats.xp / 100);
    const heldWeapons = getWeaponsFor('human', user_id);
    const weaponIcons = heldWeapons.map(row => WEAPON_DEFS[row.weapon_key].emoji).join('');
    lines.push(`${level}. ${label} — ❤️ ${health.health}/${health.max_health}${weaponIcons ? ' ' + weaponIcons : ''}`);
  }
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});

// /pick — claims one crate from the current arena drop (see arenaTick
// above). Random pick among whatever's still unclaimed in this batch,
// atomic claim (guards a same-instant double-click, though Node's
// single-threaded/synchronous execution already makes that essentially
// impossible here), one crate per player per batch.
bot.onText(/\/pick\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  if (msg.chat.id !== ARENA_CHAT_ID) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, ящики можно подбирать только в чате «Поединки».`, threadOpts(msg)).catch(() => {});
    return;
  }
  if (!isWarrior(msg.from.id)) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, нужно быть воином — введи /warrior.`, threadOpts(msg)).catch(() => {});
    return;
  }

  const state = db.prepare('SELECT current_batch_id FROM arena_drop_state WHERE id = 1').get();
  const batchId = state ? state.current_batch_id : 0;
  if (!batchId) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, ящиков ещё не было — жди, пока упадут с неба.`, threadOpts(msg)).catch(() => {});
    return;
  }
  if (db.prepare('SELECT 1 FROM arena_crates WHERE batch_id = ? AND claimed_by = ?').get(batchId, msg.from.id)) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, ты уже забрал ящик из этой волны.`, threadOpts(msg)).catch(() => {});
    return;
  }

  const candidate = db.prepare('SELECT id, crate_type FROM arena_crates WHERE batch_id = ? AND claimed_by IS NULL ORDER BY RANDOM() LIMIT 1').get(batchId);
  if (!candidate) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, ящиков больше не осталось — жди следующего падения.`, threadOpts(msg)).catch(() => {});
    return;
  }
  const claim = db.prepare('UPDATE arena_crates SET claimed_by = ? WHERE id = ? AND claimed_by IS NULL').run(msg.from.id, candidate.id);
  if (claim.changes === 0) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, опоздал — кто-то забрал этот ящик первым.`, threadOpts(msg)).catch(() => {});
    return;
  }

  if (candidate.crate_type === 'health_elixir') {
    ensureStatsRow(msg.from.id);
    db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?').run(msg.from.id);
    bot.sendMessage(msg.chat.id, `📦🧪❤️ ${actorLabel} открыл ящик и нашёл эликсир здоровья! (использовать — /restore)`, threadOpts(msg)).catch(() => {});
  } else if (candidate.crate_type === 'energy_elixir') {
    ensureStatsRow(msg.from.id);
    db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs + 1 WHERE user_id = ?').run(msg.from.id);
    bot.sendMessage(msg.chat.id, `📦🧪⚡ ${actorLabel} открыл ящик и нашёл эликсир энергии! (использовать — /recharge)`, threadOpts(msg)).catch(() => {});
  } else {
    const expiresAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    db.prepare("UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ?, expires_at = ? WHERE weapon_key = 'knife'").run(msg.from.id, msg.from.username, expiresAt);
    bot.sendMessage(msg.chat.id, `📦🔪 ${actorLabel} открыл ящик и нашёл ржавый нож! Урон ×1.5, рассыплется через 3 часа.`, threadOpts(msg)).catch(() => {});
  }
});

// /inventory — shows the current elixir stockpile (see /pick above).
bot.onText(/\/inventory\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  ensureStatsRow(msg.from.id);
  const stats = db.prepare('SELECT health_elixirs, energy_elixirs FROM pvp_stats WHERE user_id = ?').get(msg.from.id);
  bot.sendMessage(
    msg.chat.id,
    `${actorLabel}, инвентарь: 🧪❤️ эликсиров здоровья ×${stats.health_elixirs} (/restore), 🧪⚡ эликсиров энергии ×${stats.energy_elixirs} (/recharge)`,
    threadOpts(msg)
  ).catch(() => {});
});

// /restore — spends one stockpiled health elixir: +100 HP, capped at
// max_health. Not named /heal - that's already a separate admin-only
// command (clears an injury/bleed on a target by reply) further below;
// node-telegram-bot-api's onText fires every matching handler on a
// message, so reusing that name would have fired both on every /heal.
bot.onText(/\/restore\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const spent = db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs > 0 RETURNING health_elixirs').get(msg.from.id);
  if (!spent) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, у тебя нет эликсиров здоровья — глянь /inventory.`, threadOpts(msg)).catch(() => {});
    return;
  }
  const health = getUserHealth(msg.from.id);
  const after = Math.min(health.max_health, health.health + 100);
  if (after >= HOSPITAL_EXIT_HEALTH) {
    db.prepare('UPDATE user_health SET health = ?, hospitalized_since = NULL WHERE user_id = ?').run(after, msg.from.id);
  } else {
    db.prepare('UPDATE user_health SET health = ? WHERE user_id = ?').run(after, msg.from.id);
  }
  bot.sendMessage(
    msg.chat.id,
    `🧪❤️ ${actorLabel} выпил эликсир здоровья: ${health.health} -> ${after} ХП. Осталось: ${spent.health_elixirs}.`,
    threadOpts(msg)
  ).catch(() => {});
});

// /recharge — spends one stockpiled energy elixir: full refill to
// max_energy.
bot.onText(/\/recharge\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const spent = db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs - 1 WHERE user_id = ? AND energy_elixirs > 0 RETURNING energy_elixirs').get(msg.from.id);
  if (!spent) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, у тебя нет эликсиров энергии — глянь /inventory.`, threadOpts(msg)).catch(() => {});
    return;
  }
  const before = getUserHealth(msg.from.id);
  db.prepare('UPDATE user_health SET energy = max_energy WHERE user_id = ?').run(msg.from.id);
  bot.sendMessage(
    msg.chat.id,
    `🧪⚡ ${actorLabel} выпил эликсир энергии: ${before.energy} -> ${before.max_energy}. Осталось: ${spent.energy_elixirs}.`,
    threadOpts(msg)
  ).catch(() => {});
});

// /give — transfers one elixir or currently-held weapon to another warrior,
// with the receiver's explicit accept/decline (see
// docs/superpowers/specs/2026-08-24-item-transfer-design.md). Two stages,
// both handled in the callback_query listener below: gv_i (sender picks
// which item) posts a fresh message that gv_y/gv_n (receiver accepts or
// declines) resolves. Nothing is reserved ahead of time — the actual
// transfer only happens at gv_y click time, so a stale offer just fails
// gracefully instead of needing rollback.
function itemLabel(itemType) {
  if (itemType === 'elixir:health') return '🧪❤️ эликсир здоровья';
  if (itemType === 'elixir:energy') return '🧪⚡ эликсир энергии';
  const def = WEAPON_DEFS[itemType.slice('weapon:'.length)];
  return `${def.emoji} ${def.accusative}`;
}

// Target resolution copied from /kick rather than shared — this file
// duplicates these small per-command snippets instead of extracting a
// helper.
bot.onText(/\/give\b(?:@\w+)?(?:\s+@?(\S+))?/, async (msg, match) => {
  let target = null;
  if (msg.reply_to_message && msg.reply_to_message.from) {
    target = {
      id: msg.reply_to_message.from.id,
      username: msg.reply_to_message.from.username,
      firstName: msg.reply_to_message.from.first_name,
    };
  } else if (match[1]) {
    const handle = match[1].replace(/^@/, '');
    try {
      const chat = await bot.getChat('@' + handle);
      target = { id: chat.id, username: chat.username, firstName: chat.first_name };
    } catch {}
  }

  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  if (!target) {
    bot.sendMessage(msg.chat.id, 'Укажи @юзернейм или ответь на сообщение того, кому хочешь передать предмет.', threadOpts(msg)).catch(() => {});
    return;
  }
  const targetLabel = target.username ? `@${target.username}` : target.firstName;

  if (target.id === msg.from.id) {
    bot.sendMessage(msg.chat.id, 'Себе что ли? 🤔', threadOpts(msg)).catch(() => {});
    return;
  }
  if (!isWarrior(msg.from.id)) {
    bot.sendMessage(msg.chat.id, 'Сначала стань воином: /warrior', threadOpts(msg)).catch(() => {});
    return;
  }
  if (!isWarrior(target.id)) {
    bot.sendMessage(msg.chat.id, `${targetLabel} ещё не воин — нечего ему передавать.`, threadOpts(msg)).catch(() => {});
    return;
  }

  ensureStatsRow(msg.from.id);
  const stats = db.prepare('SELECT health_elixirs, energy_elixirs FROM pvp_stats WHERE user_id = ?').get(msg.from.id);
  const weapons = getWeaponsFor('human', msg.from.id);

  if (stats.health_elixirs <= 0 && stats.energy_elixirs <= 0 && weapons.length === 0) {
    bot.sendMessage(msg.chat.id, 'Нечего передать — глянь /inventory.', threadOpts(msg)).catch(() => {});
    return;
  }

  const buttons = [];
  if (stats.health_elixirs > 0) {
    buttons.push([{ text: `🧪❤️ Эликсир здоровья ×${stats.health_elixirs}`, callback_data: `gv_i:${msg.from.id}:${target.id}:elixir:health` }]);
  }
  if (stats.energy_elixirs > 0) {
    buttons.push([{ text: `🧪⚡ Эликсир энергии ×${stats.energy_elixirs}`, callback_data: `gv_i:${msg.from.id}:${target.id}:elixir:energy` }]);
  }
  for (const { weapon_key } of weapons) {
    const def = WEAPON_DEFS[weapon_key];
    buttons.push([{ text: `${def.emoji} ${def.name}`, callback_data: `gv_i:${msg.from.id}:${target.id}:weapon:${weapon_key}` }]);
  }

  bot.sendMessage(
    msg.chat.id,
    `${actorLabel}, что передать ${targetLabel}?`,
    threadOpts(msg, { reply_markup: { inline_keyboard: buttons } })
  ).catch(() => {});
});

// All of /kick's actual combat logic, factored out of the onText handler
// below (which only parses a target and weapon slot from the command
// text) so it depends on plain values instead of the raw Telegram
// message object: a chat to post in, a msg-like object for threadOpts
// (just .message_thread_id), and {id, username, firstName} attacker/
// target descriptors.
// since a button click has no such thing for the clicker.
async function performKick(chatId, msgLike, attacker, target, slot) {
  const actorLabel = attacker.username ? `@${attacker.username}` : attacker.firstName;
  const targetLabel = target.username ? `@${target.username}` : target.firstName;

  if (chatId !== ARENA_CHAT_ID) {
    bot.sendMessage(chatId, `${actorLabel}, бои разрешены только в чате «Поединки» — пиши /kick там.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (target.id === attacker.id) {
    bot.sendMessage(chatId, `${actorLabel}, нельзя ударить самого себя!`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (!isWarrior(attacker.id)) {
    bot.sendMessage(chatId, `${actorLabel}, ты ещё не воин — введи /warrior, чтобы начать драться.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (!isWarrior(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} ещё не воин — его нельзя атаковать, пока он не введёт /warrior.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isHidden(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} прячется в чулане — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isHospitalized(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} лежит в больничке — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  const attackerHealth = getUserHealth(attacker.id);
  if (isStunned(attacker.id)) {
    const stunRow = db.prepare('SELECT stunned_until FROM user_health WHERE user_id = ?').get(attacker.id);
    const minutesLeft = Math.ceil((stunRow.stunned_until * 1000 - Date.now()) / 60000);
    bot.sendMessage(chatId, `${actorLabel}, ты оглушён битой — не можешь атаковать ещё ${minutesLeft} мин.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (attackerHealth.energy === 0) {
    bot.sendMessage(chatId, `${actorLabel}, нет энергии на удар — отдохни (⚡ 1 за 20 мин).`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  // Injuries no longer block attacking outright — see
  // docs/superpowers/specs/2026-08-24-combat-attributes-design.md.
  // attackerInjury is read once here and reused below for both the
  // accuracy penalty (head) and the damage penalty (arm); the target's
  // own injury (leg, for dodge) is read separately once the dodge roll
  // actually needs it.
  const attackerInjury = getUserInjury(attacker.id);
  const attackerStats = getStats(attacker.id);

  // Weapon is resolved before the cooldown check since the cooldown is
  // keyed by weapon (see checkPvpCooldown) — which bucket applies depends
  // on what this swing actually turns out to be (including the
  // empty-slot-falls-back-to-bare-handed case). The cooldown's own
  // duration is shortened by the attacker's agility.
  const weapon = pickWeaponForAttacker('human', attacker.id, slot, PVP_WEAPONS);
  const effectiveCooldownMs = Math.max(MIN_PVP_COOLDOWN_MS, PVP_COOLDOWN_MS * (1 - attackerStats.agility * AGILITY_COOLDOWN_PER_POINT));
  const cooldownRemaining = checkPvpCooldown(attacker.id, weapon.key, effectiveCooldownMs);
  if (cooldownRemaining > 0) {
    bot.sendMessage(
      chatId,
      `${actorLabel}, нельзя бить так часто ${weapon.key ? WEAPON_DEFS[weapon.key].instrumental : 'голыми руками'} — подожди ещё ${cooldownRemaining} сек.`,
      threadOpts(msgLike)
    ).catch(() => {});
    return;
  }

  if (isHidden(attacker.id)) {
    endHideSession(attacker.id, Math.floor(Date.now() / 1000));
    await bot.sendMessage(chatId, `🚪 ${actorLabel} выскакивает из чулана, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  if (isHospitalized(attacker.id)) {
    db.prepare('UPDATE user_health SET hospitalized_since = NULL WHERE user_id = ?').run(attacker.id);
    await bot.sendMessage(chatId, `🏥 ${actorLabel} выписывается из больнички, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  if (isDefending(attacker.id)) {
    db.prepare('UPDATE buffs SET defend_until = NULL WHERE user_id = ?').run(attacker.id);
    await bot.sendMessage(chatId, `🛡️ ${actorLabel} опускает защиту, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
  }
  consumeEnergy(attacker.id);

  const bodyPart = pick(PVP_BODY_PARTS);
  const roll = Math.floor(Math.random() * 101);

  // Opposed roll: the attacker's d100 (+ точность, - head-injury penalty)
  // against the defender's own independent d100 (+ any active dodge buff
  // from getHitThreshold mapped onto this scale, + ловкость, - leg-injury
  // penalty) — the hit lands only if the attacker's side comes out
  // strictly ahead. A natural 100 always lands regardless (undodgeable
  // "СОКРУШИТЕЛЬНЫЙ УДАР"), a natural 0 always misses regardless
  // (guaranteed fumble) — neither extreme goes through the comparison.
  let success;
  let dodgedByDefender = false;
  let attackerScore = null;
  let defenderScore = null;
  if (roll === 100) {
    success = true;
  } else if (roll === 0) {
    success = false;
  } else {
    attackerScore = roll + attackerStats.accuracy * ACCURACY_PER_POINT - (attackerInjury === 'head' ? HEAD_INJURY_ACCURACY_PENALTY : 0);
    const targetInjury = getUserInjury(target.id);
    const targetStats = getStats(target.id);
    const dodgeBuffBonus = getHitThreshold(target.id) - 50; // active kuni dodge buff, mapped onto this scale
    const defendDodgeBonus = isDefending(target.id) ? DEFEND_DODGE_BONUS : 0;
    const defenderRoll = Math.floor(Math.random() * 101);
    defenderScore = defenderRoll + dodgeBuffBonus + defendDodgeBonus + targetStats.agility * AGILITY_DODGE_PER_POINT - (targetInjury === 'leg' ? LEG_INJURY_DODGE_PENALTY : 0);
    success = attackerScore > defenderScore;
    dodgedByDefender = !success;
  }

  const outcome = roll === 0 ? '❌ неудачно' : dodgedByDefender ? '🌀 уворот!' : '✅ удачно';
  const scoreText = attackerScore !== null ? ` (${Math.round(attackerScore)} против ${Math.round(defenderScore)})` : '';
  await bot.sendMessage(
    chatId,
    `${actorLabel} — ударить ${targetLabel} ${weapon.text} ${bodyPart} ${outcome}: ${roll}/100${scoreText}`,
    threadOpts(msgLike)
  ).catch(() => {});
  if (!success) {
    // Natural 0 with a real weapon in hand — fumble drops it right there
    // in this chat. owner_type = 'dropped' takes it out of everyone's
    // getWeaponsFor (so it stops counting for /kickN or /me) until the
    // pickup listener in the main message handler hands it to whoever
    // writes next (see "--- Filter muted & animal messages ---" below).
    // Bare-handed misses (weapon.key === null) have nothing to drop.
    // Losing the opposed roll (dodgedByDefender) has nothing to drop —
    // only a genuine natural-0 fumble does.
    if (roll === 0 && weapon.key) {
      db.prepare(
        "UPDATE weapon_ownership SET owner_type = 'dropped', owner_user_id = ?, owner_username = NULL, dropped_chat_id = ? WHERE weapon_key = ?"
      ).run(attacker.id, chatId, weapon.key);
      await bot.sendMessage(
        chatId,
        `😱 ${actorLabel} так мажет, что ${WEAPON_DEFS[weapon.key].name} вылетает из рук! Кто первым напишет что-нибудь в чат — подберёт.`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
    return;
  }

  // A genuinely landed hit: stamp the чулан lockout immediately (this
  // must happen regardless of what the damage-calc branch below turns
  // out to be — even a carrot "dick" heal counts as "вступил в драку").
  combatLockouts.set(attacker.id, Date.now());

  const strengthFactor = 1 + attackerStats.strength * STRENGTH_DAMAGE_PER_POINT;
  const armInjuryFactor = attackerInjury === 'arm' ? ARM_INJURY_DAMAGE_MULT : 1;
  // Excluded from nat-100, carrot "ass", carrot "dick"/"mouth" (heals,
  // not damage), and axe's flat extra -10 — same "exact-value effect,
  // not scaled by anything" precedent strengthFactor/armInjuryFactor
  // already follow for those same sites.
  const defendFactor = isDefending(target.id) ? (1 - DEFEND_DAMAGE_REDUCTION) : 1;

  const targetHealthBefore = getUserHealth(target.id);
  let targetHealthAfter;
  let hole = null;
  // Only meaningful for hole === 'ass' — whether the victim's extra 50/50
  // "clench" roll blocked the poke outright (see below). Gates the crit-
  // suppression condition further down: a BLOCKED attempt did no damage
  // at all, so there's no "already devastating enough" reason left to
  // suppress the normal crit/injury roll on this same swing.
  let assClenched = false;

  if (roll === 100) {
    targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, targetHealthBefore.health);
    await bot.sendMessage(
      chatId,
      `💯 СОКРУШИТЕЛЬНЫЙ УДАР! ${actorLabel} сносит ${targetLabel} всё здоровье разом (${targetHealthBefore.health} -> ${targetHealthAfter})!`,
      threadOpts(msgLike)
    ).catch(() => {});
  } else if (weapon.key === 'carrot') {
    const holes = ['ear', 'nose', 'mouth', 'dick', 'ass'];
    hole = holes[Math.floor(Math.random() * holes.length)];
    const rawDmg = Math.floor(Math.random() * 20) + 1;

    if (hole === 'ear') {
      const dmg = Math.round(rawDmg * 0.8 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в ухо! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'nose') {
      const dmg = Math.round(rawDmg * 0.9 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в нос! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'mouth') {
      targetHealthAfter = Math.min(targetHealthBefore.max_health, targetHealthBefore.health + 20);
      const healed = targetHealthAfter - targetHealthBefore.health;
      // Defense-in-depth: больничка already refuses to let a hospitalized
      // player be targeted at all (see isHospitalized(target.id) earlier
      // in this function), so this heal should never actually reach a
      // hospitalized target — but clear the flag here too if it somehow
      // does, same as /restore and the 4am full-restore, so
      // hospitalized_since can never go stale via this path either.
      if (targetHealthAfter >= HOSPITAL_EXIT_HEALTH) {
        db.prepare('UPDATE user_health SET health = ?, hospitalized_since = NULL WHERE user_id = ?').run(targetHealthAfter, target.id);
      } else {
        db.prepare('UPDATE user_health SET health = ? WHERE user_id = ?').run(targetHealthAfter, target.id);
      }
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в рот! ${targetLabel} с хрустом её сгрызает и получает +${healed} здоровья (${targetHealthBefore.health} -> ${targetHealthAfter})!`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'dick') {
      targetHealthAfter = Math.min(targetHealthBefore.max_health, targetHealthBefore.health + 20);
      const healed = targetHealthAfter - targetHealthBefore.health;
      if (targetHealthAfter >= HOSPITAL_EXIT_HEALTH) {
        db.prepare('UPDATE user_health SET health = ?, hospitalized_since = NULL WHERE user_id = ?').run(targetHealthAfter, target.id);
      } else {
        db.prepare('UPDATE user_health SET health = ? WHERE user_id = ?').run(targetHealthAfter, target.id);
      }
      await bot.sendMessage(chatId, `🥕😳 ${actorLabel} тычет ${targetLabel} морковкой... не туда! ${targetLabel} получает +${healed} здоровья и оргазм (${targetHealthBefore.health} -> ${targetHealthAfter})!`, threadOpts(msgLike)).catch(() => {});
    } else {
      // Extra 50/50 roll on top of the general dodge from earlier in
      // performKick — the victim gets one more chance specifically here,
      // to "clench" and block the poke outright before it becomes a
      // full health wipe.
      assClenched = Math.random() < 0.5;
      if (assClenched) {
        targetHealthAfter = targetHealthBefore.health;
        await bot.sendMessage(chatId, `🥕🍑 ${actorLabel} целится ${targetLabel} в очко, но та вовремя сжимается — морковка не проходит!`, threadOpts(msgLike)).catch(() => {});
      } else {
        targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, targetHealthBefore.health);
        await bot.sendMessage(chatId, `🥕💥 ${actorLabel} загоняет ${targetLabel} морковку в очко по самые уши! Вся жизнь снесена, ${targetLabel} в отключке (${targetHealthBefore.health} -> ${targetHealthAfter})!`, threadOpts(msgLike)).catch(() => {});
      }
    }
  } else {
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const dmg = Math.round(rawDmg * weapon.multiplier * strengthFactor * armInjuryFactor * defendFactor);
    targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(
      chatId,
      `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
      threadOpts(msgLike)
    ).catch(() => {});
  }

  // Cat/fox applies on any successful carrot hit regardless of which
  // branch produced targetHealthAfter (a hole roll above, or a natural
  // 100 bypassing hole-selection entirely) — pulled out of the carrot
  // branch itself so the nat-100 path doesn't have to duplicate it.
  if (weapon.key === 'carrot') {
    const animalType = Math.random() < 0.5 ? 'cat' : 'fox';
    applyTimedAnimal(target.id, chatId, target.username || target.firstName, animalType);
    const animalMsg = animalType === 'cat'
      ? `🐱 ${targetLabel} на 20 минут теперь мяукает как кошка!`
      : `🦊 ${targetLabel} на 20 минут теперь рычит как лиса!`;
    await bot.sendMessage(chatId, animalMsg, threadOpts(msgLike)).catch(() => {});
  }

  if (weapon.key === 'scissors') {
    applyBleed(target.id, chatId);
    await bot.sendMessage(chatId, `🩸 ${targetLabel} начинает истекать кровью от ржавых ножниц!`, threadOpts(msgLike)).catch(() => {});
    if (Math.random() < 0.05) {
      await bot.sendMessage(chatId, `✂️ ${actorLabel} случайно отчекрыжил ${targetLabel} палец ржавыми ножницами!`, threadOpts(msgLike)).catch(() => {});
    }
  }

  if (weapon.key === 'crutch') {
    applyDimon(target.id, chatId, target.username || target.firstName);
    await bot.sendMessage(chatId, `🩼 ${targetLabel} огрёб костылём и теперь бормочет как старик Димон (2 ч)!`, threadOpts(msgLike)).catch(() => {});
  }

  if (weapon.key === 'bat' && Math.random() < 0.3) {
    const stunnedUntil = Math.floor(Date.now() / 1000) + 3 * 60;
    db.prepare('UPDATE user_health SET stunned_until = ? WHERE user_id = ?').run(stunnedUntil, target.id);
    await bot.sendMessage(chatId, `🏏 ${actorLabel} оглушил ${targetLabel} битой! Не сможет атаковать 3 минуты.`, threadOpts(msgLike)).catch(() => {});
  }

  if (weapon.key === 'axe' && Math.random() < 0.2) {
    // Flat, unmodified extra damage — not scaled by strength/injury,
    // same "guaranteed bonus effect" idiom as carrot's dick heal.
    // Reassigns the outer targetHealthAfter (not a new local) so the
    // knockout-steal offer further down sees the true final health if
    // this extra 10 happens to be what floors them to 0.
    const beforeShave = targetHealthAfter;
    targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, 10);
    await bot.sendMessage(chatId, `🪓😳 ${actorLabel} топором нечаянно побрил ${targetLabel} лобок! Ещё −10 ХП (${beforeShave} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
  }

  // isCrit is tracked for stats independent of whether the injury/steal
  // side effects below actually fire — a nat-100 or carrot's "ass" is
  // still a critical hit in spirit, just with its own devastating effect
  // already covering the "this was a big deal" side effects, so the
  // usual injury+steal block is suppressed for those two specifically.
  const isCrit = roll >= getCritThreshold(attacker.id);
  if (isCrit) {
    recordCrit(attacker.id);
  }
  // Every landed, non-dodged hit earns XP, tiered by outcome — this is
  // reached unconditionally (unlike the injury+steal block below, which
  // stays gated on roll !== 100 and the carrot-ass suppression).
  const xpGain = roll === 100 ? XP_PER_NAT100 : isCrit ? XP_PER_CRIT : XP_PER_HIT;
  ensureStatsRow(attacker.id);
  db.prepare('UPDATE pvp_stats SET xp = xp + ? WHERE user_id = ?').run(xpGain, attacker.id);
  if (roll !== 100 && isCrit && !(weapon.key === 'carrot' && hole === 'ass' && !assClenched)) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healHours = applyInjury(target.id, injuryType);
    recordInjuryDealt(attacker.id);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      chatId,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healHours} ч).`,
      threadOpts(msgLike)
    ).catch(() => {});
    if (weapon.key === 'horns') {
      await bot.sendMessage(chatId, `🐂 ${actorLabel} насадила ${targetLabel} на рога!`, threadOpts(msgLike)).catch(() => {});
    }
  }

  // Knockout weapon-steal offer — the only way to take a weapon off
  // someone now (see docs/superpowers/specs/2026-08-19-knockout-steal-
  // buttons-design.md); the old silent 5%-on-crit auto-steal is gone.
  // Looked up live rather than from a value cached earlier in this
  // handler, same defensive idiom as before. If the victim holds more
  // than one weapon, one button per weapon lets the attacker choose
  // which single one to try for (see the callback handler below, which
  // now also rolls 50/50 on whether the grab actually succeeds).
  if (targetHealthAfter === 0) {
    const heldWeapons = getWeaponsFor('human', target.id);
    if (heldWeapons.length > 0) {
      const defs = heldWeapons.map(row => WEAPON_DEFS[row.weapon_key]);
      const itemsText = defs.length === 1
        ? defs[0].accusative
        : defs.slice(0, -1).map(d => d.accusative).join(', ') + ' и ' + defs[defs.length - 1].accusative;
      const question = defs.length === 1 ? 'Забрать?' : 'Что забрать?';
      await bot.sendMessage(
        chatId,
        `${targetLabel} в отключке — с ним ${itemsText}. ${question}`,
        threadOpts(msgLike, {
          reply_markup: {
            inline_keyboard: [
              ...heldWeapons.map(row => [{
                text: `🗡 Забрать ${WEAPON_DEFS[row.weapon_key].accusative}`,
                callback_data: `steal_yes:${attacker.id}:${target.id}:${row.weapon_key}`,
              }]),
              [{ text: '🤝 Оставить', callback_data: `steal_no:${attacker.id}` }],
            ],
          },
        })
      ).catch(() => {});
    }
  }
}

// Target resolution: reply-to-message first, else a best-effort
// bot.getChat('@handle') — this bot has no relationships table to look
// usernames up against locally, unlike troll-bot's "Тролль Фас".
// /kick (no number) always swings bare-handed, even for someone holding
// real weapons — /kick1/2/3 picks a specific held weapon by slot (see
// pickWeaponForAttacker), falling back to bare-handed if that slot is
// empty. match[1] is the slot digit, match[2] is the target text. All
// the actual combat logic lives in performKick above.
bot.onText(/\/kick([1-3])?(?!\w)(?:@\w+)?(?:\s+@?(\S+))?/, async (msg, match) => {
  const slot = match[1] ? parseInt(match[1], 10) : 0;

  let target = null;
  if (msg.reply_to_message && msg.reply_to_message.from) {
    target = {
      id: msg.reply_to_message.from.id,
      username: msg.reply_to_message.from.username,
      firstName: msg.reply_to_message.from.first_name,
    };
  } else if (match[2]) {
    const handle = match[2].replace(/^@/, '');
    try {
      const chat = await bot.getChat('@' + handle);
      target = { id: chat.id, username: chat.username, firstName: chat.first_name };
    } catch {}
  }

  if (!target) {
    bot.sendMessage(msg.chat.id, 'Укажи @юзернейм или ответь на сообщение того, кого хочешь ударить.', threadOpts(msg)).catch(() => {});
    return;
  }

  await performKick(msg.chat.id, msg, { id: msg.from.id, username: msg.from.username, firstName: msg.from.first_name }, target, slot);
});

// /defend — voluntary 30-min self-buff trading offense for defense (see
// docs/superpowers/specs/2026-08-24-hospital-and-defend-design.md).
// Always succeeds once energy is paid (unlike the kuni buffs' 50/50 —
// this is "assume a stance," not an attempt that can fail). Cooldown is
// the stance's own duration, same pattern as kuniFun/kuniAlia/kuniTama.
bot.onText(/\/defend\b/i, (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT defend_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.defend_until > now) {
    const minutesLeft = Math.ceil((row.defend_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, стойка уже активна (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  if (consumeEnergy(msg.from.id, DEFEND_ENERGY_COST) === null) {
    const current = getUserHealth(msg.from.id).energy;
    return bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии на стойку (нужно ${DEFEND_ENERGY_COST}, есть ${current}).`, threadOpts(msg));
  }
  const until = now + DEFEND_DURATION_MS / 1000;
  db.prepare(
    'INSERT INTO buffs (user_id, defend_until) VALUES (?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET defend_until = excluded.defend_until'
  ).run(msg.from.id, until);
  bot.sendMessage(msg.chat.id, `🛡️ ${actorLabel} встаёт в защитную стойку на 30 мин: +${DEFEND_DODGE_BONUS} к увороту, −${Math.round(DEFEND_DAMAGE_REDUCTION * 100)}% входящего урона. Атака снимет стойку.`, threadOpts(msg)).catch(() => {});
});

// --- /kuniFun, /kuniAlia, /kuniTama: public self-buffs, no reply/target
// needed (see docs/superpowers/specs/2026-08-16-kuni-buffs-design.md).
// Each command's cooldown always matches its own buff's 10-minute
// duration, so "on cooldown" and "buff still active" are the same check.
// Energy is spent on every attempt, success or the 50/50 "не вышло" —
// same "the attempt costs the resource" idiom as /kick's own energy
// spend, which happens before its hit/miss roll too.
const KUNI_ENERGY_COST = 2;
bot.onText(/\/kuniFun\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT fun_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.fun_cd_until > now) {
    const minutesLeft = Math.ceil((row.fun_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  if (consumeEnergy(msg.from.id, KUNI_ENERGY_COST) === null) {
    const current = getUserHealth(msg.from.id).energy;
    return bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии на куни (нужно ${KUNI_ENERGY_COST}, есть ${current}).`, threadOpts(msg));
  }
  const until = now + 600;
  const roll = Math.floor(Math.random() * 101);
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, fun_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET fun_cd_until = excluded.fun_cd_until'
    ).run(msg.from.id, until);
    return bot.sendMessage(msg.chat.id, `${actorLabel} попытался сделать куни InternalFun, но не вышло 😅 (${roll}/100)`, threadOpts(msg));
  }
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, fun_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.5, crit_until = excluded.crit_until, fun_cd_until = excluded.fun_cd_until'
  ).run(msg.from.id, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни InternalFun и теперь стал более опасен ⚡ (+крит на 10 мин): ${roll}/100`, threadOpts(msg));
});

bot.onText(/\/kuniAlia\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT alia_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.alia_cd_until > now) {
    const minutesLeft = Math.ceil((row.alia_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  if (consumeEnergy(msg.from.id, KUNI_ENERGY_COST) === null) {
    const current = getUserHealth(msg.from.id).energy;
    return bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии на куни (нужно ${KUNI_ENERGY_COST}, есть ${current}).`, threadOpts(msg));
  }
  const until = now + 600;
  const roll = Math.floor(Math.random() * 101);
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, alia_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET alia_cd_until = excluded.alia_cd_until'
    ).run(msg.from.id, until);
    return bot.sendMessage(msg.chat.id, `${actorLabel} попытался сделать куни AliyaKuzAli, но не вышло 😅 (${roll}/100)`, threadOpts(msg));
  }
  db.prepare(
    'INSERT INTO buffs (user_id, dodge_mult, dodge_until, alia_cd_until) VALUES (?, 1.5, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET dodge_mult = 1.5, dodge_until = excluded.dodge_until, alia_cd_until = excluded.alia_cd_until'
  ).run(msg.from.id, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни AliyaKuzAli и теперь лучше уклоняется 🌀 (+уклонение на 10 мин): ${roll}/100`, threadOpts(msg));
});

bot.onText(/\/kuniTama\b/, async (msg) => {
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT tama_cd_until FROM buffs WHERE user_id = ?').get(msg.from.id);
  if (row && row.tama_cd_until > now) {
    const minutesLeft = Math.ceil((row.tama_cd_until - now) / 60);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, бафф уже активен (ещё ${minutesLeft} мин).`, threadOpts(msg));
  }
  if (consumeEnergy(msg.from.id, KUNI_ENERGY_COST) === null) {
    const current = getUserHealth(msg.from.id).energy;
    return bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии на куни (нужно ${KUNI_ENERGY_COST}, есть ${current}).`, threadOpts(msg));
  }
  const until = now + 600;
  const roll = Math.floor(Math.random() * 101);
  if (roll < 50) {
    db.prepare(
      'INSERT INTO buffs (user_id, tama_cd_until) VALUES (?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET tama_cd_until = excluded.tama_cd_until'
    ).run(msg.from.id, until);
    return bot.sendMessage(msg.chat.id, `${actorLabel} попытался сделать куни Tama, но не вышло 😅 (${roll}/100)`, threadOpts(msg));
  }
  db.prepare(
    'INSERT INTO buffs (user_id, crit_mult, crit_until, dodge_mult, dodge_until, tama_cd_until) VALUES (?, 1.25, ?, 1.25, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET crit_mult = 1.25, crit_until = excluded.crit_until, dodge_mult = 1.25, dodge_until = excluded.dodge_until, tama_cd_until = excluded.tama_cd_until'
  ).run(msg.from.id, until, until, until);
  bot.sendMessage(msg.chat.id, `${actorLabel} сделал куни Tama и теперь стал опаснее и увёртливее ✨ (+крит и +уклонение на 10 мин): ${roll}/100`, threadOpts(msg));
});

// --- Animal assign/unassign (admin only, reply required) ---
for (const [animalType, { emoji }] of Object.entries(ANIMALS)) {
  bot.onText(new RegExp(`^\\/${animalType}\\b`, 'i'), async (msg) => {
    if (!await isAdmin(msg)) return;
    const user = await resolveUser(msg);
    if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
    if (user.id === bot.id) return;

    const byName = await getDisplayName(msg);
    const existingAnimal = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(user.id);
    const wasEstet = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(user.id);
    const wasFisher = db.prepare('SELECT 1 FROM fishers WHERE user_id = ?').get(user.id);
    const wasPodhalim = db.prepare('SELECT 1 FROM podhalims WHERE user_id = ?').get(user.id);
    db.prepare('DELETE FROM estets WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM fishers WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM podhalims WHERE user_id = ?').run(user.id);
    db.prepare(
      'INSERT OR REPLACE INTO animals (user_id, chat_id, username, animal, added_by, added_by_name) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, msg.chat.id, user.username, animalType, msg.from.id, byName);

    const prevTags = [
      existingAnimal && existingAnimal.animal !== animalType ? (ANIMALS[existingAnimal.animal]?.emoji || existingAnimal.animal) : null,
      wasEstet ? '🎨' : null,
      wasFisher ? '🎣' : null,
      wasPodhalim ? '🫦' : null,
    ].filter(Boolean);
    const wasMsg = prevTags.length ? ` (был ${prevTags.join(', ')})` : '';
    bot.sendMessage(msg.chat.id, `${user.username}${wasMsg} теперь ${emoji}`, threadOpts(msg));
  });

  bot.onText(new RegExp(`^\\/un${animalType}\\b`, 'i'), async (msg) => {
    if (!await isAdmin(msg)) return;
    const user = await resolveUser(msg);
    if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

    db.prepare('DELETE FROM animals WHERE user_id = ?').run(user.id);
    bot.sendMessage(msg.chat.id, `${user.username} больше не ${emoji}`, threadOpts(msg));
  });
}

// --- Human (remove from all animal groups) ---
bot.onText(/\/human\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  const existing = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(user.id);
  const wasRamzan = db.prepare('SELECT 1 FROM ramzans WHERE user_id = ?').get(user.id);
  const wasFisher = db.prepare('SELECT 1 FROM fishers WHERE user_id = ?').get(user.id);
  const wasEstet = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(user.id);
  const wasPodhalim = db.prepare('SELECT 1 FROM podhalims WHERE user_id = ?').get(user.id);
  const wasMolchun = db.prepare('SELECT 1 FROM molchuns WHERE user_id = ?').get(user.id);
  db.prepare('DELETE FROM animals WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM ramzans WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM fishers WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM estets WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM podhalims WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM molchuns WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM dimoniacs WHERE user_id = ?').run(user.id);

  const tags = [
    existing ? (ANIMALS[existing.animal]?.emoji || existing.animal) : null,
    wasRamzan ? 'Дон' : null,
    wasFisher ? '🎣' : null,
    wasEstet ? '🎨' : null,
    wasPodhalim ? '🫦' : null,
    wasMolchun ? '🤐' : null,
  ].filter(Boolean);
  const wasMsg = tags.length ? ` (был ${tags.join(', ')})` : '';
  bot.sendMessage(msg.chat.id, `${user.username}${wasMsg} теперь человек 🧑`, threadOpts(msg));
});

// --- Fisher ---
bot.onText(/\/fisher\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
  if (user.id === bot.id) return;

  const byName = await getDisplayName(msg);
  const existingAnimal = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(user.id);
  const wasEstet = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(user.id);
  const wasPodhalim = db.prepare('SELECT 1 FROM podhalims WHERE user_id = ?').get(user.id);
  db.prepare('DELETE FROM animals WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM estets WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM podhalims WHERE user_id = ?').run(user.id);
  const expiresAt = Math.floor((Date.now() + 5 * 60 * 1000) / 1000);
  db.prepare(
    'INSERT OR REPLACE INTO fishers (user_id, chat_id, username, added_by, added_by_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(user.id, msg.chat.id, user.username, msg.from.id, byName, expiresAt);

  const prevTags = [
    existingAnimal ? (ANIMALS[existingAnimal.animal]?.emoji || existingAnimal.animal) : null,
    wasEstet ? '🎨' : null,
    wasPodhalim ? '🫦' : null,
  ].filter(Boolean);
  const wasMsg = prevTags.length ? ` (был ${prevTags.join(', ')})` : '';
  bot.sendMessage(msg.chat.id, `${user.username}${wasMsg} теперь 🎣 на 5 минут`, threadOpts(msg));
});

bot.onText(/\/unfisher\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  db.prepare('DELETE FROM fishers WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} больше не 🎣`, threadOpts(msg));
});

// --- Ramzan ---
bot.onText(/\/ramzan\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
  if (user.id === bot.id) return;

  const byName = await getDisplayName(msg);
  db.prepare(
    'INSERT OR REPLACE INTO ramzans (user_id, chat_id, username, added_by, added_by_name) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, msg.chat.id, user.username, msg.from.id, byName);

  bot.sendMessage(msg.chat.id, `${user.username} теперь Дон`, threadOpts(msg));
});

bot.onText(/\/unramzan\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  db.prepare('DELETE FROM ramzans WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} больше не Дон`, threadOpts(msg));
});

// --- Estet ---
bot.onText(/\/estet\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
  if (user.id === bot.id) return;

  const byName = await getDisplayName(msg);
  const existingAnimal = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(user.id);
  const wasFisher = db.prepare('SELECT 1 FROM fishers WHERE user_id = ?').get(user.id);
  const wasPodhalim = db.prepare('SELECT 1 FROM podhalims WHERE user_id = ?').get(user.id);
  db.prepare('DELETE FROM animals WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM fishers WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM podhalims WHERE user_id = ?').run(user.id);
  db.prepare(
    'INSERT OR REPLACE INTO estets (user_id, chat_id, username, added_by, added_by_name) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, msg.chat.id, user.username, msg.from.id, byName);

  const prevTags = [
    existingAnimal ? (ANIMALS[existingAnimal.animal]?.emoji || existingAnimal.animal) : null,
    wasFisher ? '🎣' : null,
    wasPodhalim ? '🫦' : null,
  ].filter(Boolean);
  const wasMsg = prevTags.length ? ` (был ${prevTags.join(', ')})` : '';
  bot.sendMessage(msg.chat.id, `${user.username}${wasMsg} теперь 🎨 эстет`, threadOpts(msg));
});

bot.onText(/\/unestet\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  db.prepare('DELETE FROM estets WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} больше не 🎨 эстет`, threadOpts(msg));
});

// --- Podhalim ---
bot.onText(/\/podhalim\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
  if (user.id === bot.id) return;

  const byName = await getDisplayName(msg);
  const existingAnimal = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(user.id);
  const wasEstet = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(user.id);
  const wasFisher = db.prepare('SELECT 1 FROM fishers WHERE user_id = ?').get(user.id);
  db.prepare('DELETE FROM animals WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM estets WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM fishers WHERE user_id = ?').run(user.id);
  db.prepare(
    'INSERT OR REPLACE INTO podhalims (user_id, chat_id, username, added_by, added_by_name) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, msg.chat.id, user.username, msg.from.id, byName);

  const prevTags = [
    existingAnimal ? (ANIMALS[existingAnimal.animal]?.emoji || existingAnimal.animal) : null,
    wasEstet ? '🎨' : null,
    wasFisher ? '🎣' : null,
  ].filter(Boolean);
  const wasMsg = prevTags.length ? ` (был ${prevTags.join(', ')})` : '';
  bot.sendMessage(msg.chat.id, `${user.username}${wasMsg} теперь 🫦 подхалим`, threadOpts(msg));
});

bot.onText(/\/unpodhalim\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  db.prepare('DELETE FROM podhalims WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} больше не 🫦 подхалим`, threadOpts(msg));
});

// --- Molchun ---
bot.onText(/\/molchun(?:\s+(\d+))?/, async (msg, match) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
  if (user.id === bot.id) return;

  const minutes = parseInt(match[1] || '5');
  const byName = await getDisplayName(msg);
  const expiresAt = Math.floor((Date.now() + minutes * 60 * 1000) / 1000);
  db.prepare(
    'INSERT OR REPLACE INTO molchuns (user_id, chat_id, username, added_by, added_by_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(user.id, msg.chat.id, user.username, msg.from.id, byName, expiresAt);

  bot.sendMessage(msg.chat.id, `${user.username} теперь 🤐 на ${minutes} мин`, threadOpts(msg));
});

bot.onText(/\/unmolchun\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  db.prepare('DELETE FROM molchuns WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} больше не 🤐`, threadOpts(msg));
});

// --- Dimon (старик) ---
bot.onText(/\/dimon\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
  if (user.id === bot.id) return;

  const byName = await getDisplayName(msg);
  db.prepare(
    'INSERT OR REPLACE INTO dimoniacs (user_id, chat_id, username, added_by, added_by_name, message_count) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(user.id, msg.chat.id, user.username, msg.from.id, byName);

  bot.sendMessage(msg.chat.id, `${user.username} теперь 🧓 старик Димон`, threadOpts(msg));
});

bot.onText(/\/undimon\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  db.prepare('DELETE FROM dimoniacs WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} больше не 🧓`, threadOpts(msg));
});

// --- DedoVirus.2026: patient zero ---
bot.onText(/\/0patient\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
  if (user.id === bot.id) return;

  const byName = await getDisplayName(msg);
  // @-prefix to match the cough-spread infection path's stored username
  // convention (virusNick), so /epidemic and the hourly broadcast show
  // patient zero and naturally-infected users in the same format.
  const targetNick = msg.reply_to_message.from.username ? `@${user.username}` : user.username;
  db.prepare(
    'INSERT OR REPLACE INTO virus_infections (user_id, chat_id, username, stage, is_patient_zero, immune, message_count, added_by, added_by_name) VALUES (?, ?, ?, 3, 1, 0, 0, ?, ?)'
  ).run(user.id, msg.chat.id, targetNick, msg.from.id, byName);

  bot.sendMessage(msg.chat.id, `☣️ ${targetNick} — нулевой пациент эпидемии DedoVirus.2026!`, threadOpts(msg));
});

const VIRUS_PROCEDURE_PUBLIC_TARGETS = { klizma: 'anokibdsmovna', massage: 'murrmelady' };

function applyVirusProcedure(type) {
  return async (msg) => {
    const user = await resolveUser(msg);
    const allowedTarget = VIRUS_PROCEDURE_PUBLIC_TARGETS[type];
    const isPublicTarget = !!user && allowedTarget && user.username?.toLowerCase() === allowedTarget;
    if (!isPublicTarget && !await isAdmin(msg)) return;

    if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));
    if (user.id === bot.id) return;

    const { durationMs } = VIRUS_PROCEDURES[type];
    const expiresAt = Math.floor((Date.now() + durationMs) / 1000);
    db.prepare(
      'INSERT OR REPLACE INTO virus_procedures (user_id, procedure_type, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, type, expiresAt);

    bot.sendMessage(msg.chat.id, `${user.username} получил процедуру: ${type}`, threadOpts(msg));
  };
}

bot.onText(/\/ukol\b/, applyVirusProcedure('ukol'));
bot.onText(/\/klizma\b/, applyVirusProcedure('klizma'));
bot.onText(/\/topor\b/, applyVirusProcedure('topor'));
bot.onText(/\/massage\b/, applyVirusProcedure('massage'));

function formatVirusList() {
  const rows = db.prepare('SELECT * FROM virus_infections WHERE immune = 0 ORDER BY is_patient_zero DESC, stage DESC').all();
  if (!rows.length) return null;
  const lines = ['☣️ DedoVirus.2026'];
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
  return lines.join('\n');
}

bot.onText(/\/epidemic\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, formatVirusList() || 'Эпидемии нет', threadOpts(msg));
});

bot.onText(/\/cure\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  const row = getVirusRow(user.id);
  if (!row) return bot.sendMessage(msg.chat.id, `${user.username} не заражён`, threadOpts(msg));
  if (row.is_patient_zero) return bot.sendMessage(msg.chat.id, 'Нулевого пациента вылечить нельзя, используй /endvirus', threadOpts(msg));
  if (row.strain === 'beta' && row.stage === 4) return bot.sendMessage(msg.chat.id, 'Секс-зомби вылечить нельзя, используй /endvirus', threadOpts(msg));

  db.prepare('UPDATE virus_infections SET immune = 1 WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM virus_procedures WHERE user_id = ?').run(user.id);
  bot.sendMessage(msg.chat.id, `${user.username} вылечен от DedoVirus и получил иммунитет`, threadOpts(msg));
});

// Admin-only, reply-to-message targeting (same as /cure above) — clears
// both an arm/leg/head injury and an active scissors bleed in one shot.
// Deliberately doesn't touch health points or an active "драка" mute —
// those are a separate mechanic (health regen ticks on its own, mute
// expires on its own timer) and stay out of scope here. The DELETE/UPDATE
// below are harmless no-ops if the respective condition was already
// false, so there's no need to branch on each independently — only the
// "nothing to heal at all" case needs its own early return/message.
bot.onText(/\/heal\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const user = await resolveUser(msg);
  if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

  const injuryRow = db.prepare('SELECT 1 FROM injuries WHERE user_id = ?').get(user.id);
  const bleedRow = db.prepare('SELECT bleed_until FROM user_health WHERE user_id = ?').get(user.id);
  const wasBleeding = bleedRow && bleedRow.bleed_until && bleedRow.bleed_until * 1000 > Date.now();

  if (!injuryRow && !wasBleeding) {
    return bot.sendMessage(msg.chat.id, `${user.username} и так здоров, лечить нечего`, threadOpts(msg));
  }

  db.prepare('DELETE FROM injuries WHERE user_id = ?').run(user.id);
  db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(user.id);

  const healed = [injuryRow ? 'травма' : null, wasBleeding ? 'кровотечение' : null].filter(Boolean).join(' и ');
  bot.sendMessage(msg.chat.id, `${user.username} вылечен: ${healed}`, threadOpts(msg));
});

bot.onText(/\/endvirus\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  db.exec('DELETE FROM virus_infections');
  db.exec('DELETE FROM virus_procedures');
  bot.sendMessage(msg.chat.id, 'Эпидемия DedoVirus.2026 закончена', threadOpts(msg));
});

bot.onText(/\/patient\b/, async (msg) => {
  let targetId = msg.from.id;
  let targetNick = await getDisplayName(msg);
  if (msg.reply_to_message && await isAdmin(msg)) {
    const user = await resolveUser(msg);
    targetId = user.id;
    targetNick = msg.reply_to_message.from.username ? `@${user.username}` : user.username;
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

bot.onText(/\/immune\b/, async (msg) => {
  const virusRow = getVirusRow(msg.from.id);
  const nick = await getDisplayName(msg);
  if (!virusRow || virusRow.immune) return bot.sendMessage(msg.chat.id, 'Ты не болен', threadOpts(msg));
  if (virusRow.energy < 100) return bot.sendMessage(msg.chat.id, `Недостаточно энергии (${virusRow.energy}/100)`, threadOpts(msg));

  db.prepare('UPDATE virus_infections SET energy = 0 WHERE user_id = ?').run(msg.from.id);

  if (virusRow.is_patient_zero) {
    return bot.sendMessage(msg.chat.id, `🦠 ${nick}: иммунная система бессильна против нулевого пациента`, threadOpts(msg));
  }
  if (virusRow.strain === 'beta' && virusRow.stage === 4) {
    return bot.sendMessage(msg.chat.id, `🧟 ${nick}: иммунная система бессильна против секс-зомби`, threadOpts(msg));
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

bot.onText(/\/quarantine\b/, async (msg) => {
  if (!await isAdmin(msg)) return;
  const expiresAt = Math.floor((Date.now() + VIRUS_QUARANTINE_DURATION_MS) / 1000);
  db.prepare('INSERT OR REPLACE INTO virus_quarantine (id, expires_at) VALUES (1, ?)').run(expiresAt);
  bot.sendMessage(msg.chat.id, '🏥 Объявлен карантин на 24 часа! Заразиться сложнее, вылечиться — легче.', threadOpts(msg));
});

// --- List animals ---
bot.onText(/\/animals/, (msg) => {
  const animalRows = db.prepare('SELECT username, animal, added_by_name FROM animals ORDER BY animal, created_at DESC').all();
  const ramzanRows = db.prepare('SELECT username, added_by_name FROM ramzans ORDER BY created_at DESC').all();
  const estetRows = db.prepare('SELECT username, added_by_name FROM estets ORDER BY created_at DESC').all();
  const podhalimRows = db.prepare('SELECT username, added_by_name FROM podhalims ORDER BY created_at DESC').all();
  const now = Math.floor(Date.now() / 1000);
  const fisherRows = db.prepare('SELECT username, added_by_name, expires_at FROM fishers WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC').all(now);
  const molchunRows = db.prepare('SELECT username, added_by_name, expires_at FROM molchuns WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC').all(now);
  if (!animalRows.length && !ramzanRows.length && !fisherRows.length && !estetRows.length && !podhalimRows.length && !molchunRows.length) return bot.sendMessage(msg.chat.id, 'Список пуст', threadOpts(msg));
  const lines = [
    ...animalRows.map(r => `${ANIMALS[r.animal]?.emoji || '?'} ${r.username} — ${ANIMALS[r.animal]?.sound || r.animal} (от ${r.added_by_name})`),
    ...ramzanRows.map(r => `🗣 ${r.username} — Дон (от ${r.added_by_name})`),
    ...fisherRows.map(r => `🎣 ${r.username} — ${formatExpire(r.expires_at)} (от ${r.added_by_name})`),
    ...estetRows.map(r => `🎨 ${r.username} — эстет (от ${r.added_by_name})`),
    ...podhalimRows.map(r => `🫦 ${r.username} — подхалим (от ${r.added_by_name})`),
    ...molchunRows.map(r => `🤐 ${r.username} — молчун ${formatExpire(r.expires_at)} (от ${r.added_by_name})`),
  ];
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg));
});

// --- Auto-fisher: 2+ "рыбалка" within 15s ---
const fishingTracker = new Map();

// Counts messages per marked user while troll_smell has them — the callout
// fires every 3rd message instead of every single one now. In-memory only
// (like fishingTracker above): a restart just resets the count, no need to
// persist it. Not reset when marked_at is refreshed by a new poop-game loss
// — it just keeps counting continuously for as long as the user is marked.
const smellMessageCounts = new Map();

// Leg-injury "хромает" throttle (see troll-bot's "Драка" game, which writes
// to the injuries table) — identical in-memory-counter shape to
// smellMessageCounts above: every 3rd message while the leg injury is
// active gets the limp line, reset when the injury clears.
const limpMessageCounts = new Map();

// Head-injury nonsense replies — flat per-message chance (see the injuries
// check below), not a counter like leg's, since "sometimes talks nonsense"
// reads as a dice roll rather than a fixed cadence.
const HEAD_INJURY_CHANCE = 0.25;
const HEAD_INJURY_PHRASES = [
  'Ты вообще о чём?',
  'Моя видеть единорога, извини, что?',
  'Погоди, а где мои носки?',
  'Кажется, только что была вспышка света... или нет?',
  'Стоп, а мы вообще о чём говорили?',
  'Ой, голова кружится... что твоя сказать?',
  'Мимо. Полностью мимо.',
  'Твоя такое говорить, а моя видеть только звёздочки.',
];

// --- Filter muted & animal messages ---
bot.on('message', async (msg) => {
  if (msg.from?.is_bot) return;
  // One-time weapon-owner resolution: fires at most once per weapon key,
  // ever — gated on owner_type = 'human' as well as owner_user_id IS NULL
  // because a troll steal also sets owner_user_id back to NULL (troll-bot
  // still has its own separate 5%-on-crit auto-steal, untouched — this
  // file's own copy was removed), and without this guard a message
  // from the original seed user after a troll steal would re-fire this
  // UPDATE and overwrite owner_user_id/owner_username back to the human
  // while owner_type stayed 'troll' — an inconsistent row. Must run
  // unconditionally, before any early return below, so a muted/fisher/
  // molchun @ANOKI5 or @InternalFun still gets linked up the first time.
  if (msg.from.username) {
    db.prepare("UPDATE weapon_ownership SET owner_user_id = ?, owner_username = ? WHERE seed_username = ? AND owner_type = 'human' AND owner_user_id IS NULL").run(msg.from.id, msg.from.username, msg.from.username);
  }
  // known_users cache (see /find below) — refreshed on every message so
  // display names stay current even if someone changes their @username.
  db.prepare(
    'INSERT INTO known_users (user_id, username, first_name, last_seen_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, last_seen_at = excluded.last_seen_at'
  ).run(msg.from.id, msg.from.username || null, msg.from.first_name || null, Math.floor(Date.now() / 1000));
  // Natural-0 fumble pickup (see /kick's drop above): first message in the
  // drop's chat from anyone but the dropper claims it. Runs unconditionally,
  // same reasoning as the resolution UPDATE above — a muted/fisher/molchun
  // user's message still counts as "writing something in the chat".
  const droppedHere = db.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'dropped' AND dropped_chat_id = ? AND owner_user_id != ?"
  ).all(msg.chat.id, msg.from.id);
  for (const row of droppedHere) {
    const changed = db.prepare(
      "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ?, dropped_chat_id = NULL WHERE weapon_key = ? AND owner_type = 'dropped' AND dropped_chat_id = ?"
    ).run(msg.from.id, msg.from.username, row.weapon_key, msg.chat.id);
    if (changed.changes > 0) {
      const def = WEAPON_DEFS[row.weapon_key];
      const finderLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      bot.sendMessage(msg.chat.id, `${def.emoji} ${finderLabel} находит и забирает ${def.accusative} — теперь бьёт ${def.instrumental} сам!`, threadOpts(msg)).catch(() => {});
    }
  }
  // must run first, unconditionally — otherwise muted/fisher/molchun users' messages never enter the recency buffer, breaking cough-targeting later
  const virusNick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const virusPriorRecent = getVirusRecent(msg.chat.id);
  pushVirusRecent(msg.chat.id, { userId: msg.from.id, username: virusNick });
  rememberMessageAuthor(msg.chat.id, msg.message_id, { userId: msg.from.id, username: virusNick, threadId: msg.message_thread_id });
  if (isMuted(msg.from.id)) {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    const row = db.prepare('SELECT expires_at, muted_by_name FROM mutes WHERE user_id = ?').get(msg.from.id);
    // Knocked out by "Драка" (0 health) gets its own flavor line instead of
    // the normal admin-mute message — same underlying mute mechanism either
    // way, see muteUser/isMuted above. tg-bot's own /kick no longer ever
    // writes this mute (больничка replaced it, see hospitalized_since) —
    // this branch is now only ever reached via a troll-bot-caused
    // knockout, which still writes a 'драка' mute of its own into this
    // same shared table.
    if (row && row.muted_by_name === 'драка') {
      bot.sendMessage(msg.chat.id, `😵 ${msg.from.first_name} находится в отключке...`, threadOpts(msg)).catch(() => {});
      return;
    }
    const until = row ? formatExpire(row.expires_at) : '';
    bot.sendMessage(msg.chat.id, `${msg.from.first_name}, вы замучены ${until}`, threadOpts(msg)).catch(() => {});
    return;
  }

  // Marked by troll-bot's pee/poop-game mechanics — every message for the
  // duration gets called out, on purpose (that's the joke).
  const smellRow = db.prepare('SELECT expires_at, reason FROM troll_smell WHERE user_id = ?').get(msg.from.id);
  if (smellRow) {
    if (smellRow.expires_at * 1000 < Date.now()) {
      db.prepare('DELETE FROM troll_smell WHERE user_id = ?').run(msg.from.id);
      smellMessageCounts.delete(msg.from.id);
    } else {
      const smellCount = (smellMessageCounts.get(msg.from.id) || 0) + 1;
      smellMessageCounts.set(msg.from.id, smellCount);
      if (smellCount % 3 === 0) {
        const smellText = smellRow.reason === 'poop'
          ? `🌸 от ${msg.from.first_name} пахнет фиалками, точно так же как пахнет говно тролля...`
          : `💦 от ${msg.from.first_name} несёт мочой тролля...`;
        bot.sendMessage(msg.chat.id, smellText, threadOpts(msg)).catch(() => {});
      }
    }
  }

  // Injury passive effects (see troll-bot's "Драка" game, which writes to
  // the injuries table on a critical hit) — lazily expired here the same
  // way troll_smell/mutes already are, not a separate cleanup job.
  const injuryRow = db.prepare('SELECT injury_type, injured_until FROM injuries WHERE user_id = ?').get(msg.from.id);
  if (injuryRow) {
    if (injuryRow.injured_until * 1000 < Date.now()) {
      db.prepare('DELETE FROM injuries WHERE user_id = ?').run(msg.from.id);
      limpMessageCounts.delete(msg.from.id);
    } else if (injuryRow.injury_type === 'leg') {
      const limpCount = (limpMessageCounts.get(msg.from.id) || 0) + 1;
      limpMessageCounts.set(msg.from.id, limpCount);
      if (limpCount % 3 === 0) {
        bot.sendMessage(msg.chat.id, `🦵 ${msg.from.first_name} хромает...`, threadOpts(msg)).catch(() => {});
      }
    } else if (injuryRow.injury_type === 'head' && Math.random() < HEAD_INJURY_CHANCE) {
      const nonsense = HEAD_INJURY_PHRASES[Math.floor(Math.random() * HEAD_INJURY_PHRASES.length)];
      bot.sendMessage(msg.chat.id, nonsense, { reply_to_message_id: msg.message_id, ...threadOpts(msg) }).catch(() => {});
    }
  }

  // Auto-fisher trigger
  if (msg.text && /рыбалк/i.test(msg.text)) {
    const now = Date.now();
    const times = (fishingTracker.get(msg.from.id) || []).filter(t => now - t < 15000);
    times.push(now);
    fishingTracker.set(msg.from.id, times);
    if (times.length >= 2) {
      fishingTracker.delete(msg.from.id);
      const alreadyFisher = db.prepare('SELECT 1 FROM fishers WHERE user_id = ?').get(msg.from.id);
      if (!alreadyFisher) {
        const expiresAt = Math.floor((now + 5 * 60 * 1000) / 1000);
        const username = msg.from.username || msg.from.first_name;
        db.prepare(
          'INSERT OR REPLACE INTO fishers (user_id, chat_id, username, added_by, added_by_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(msg.from.id, msg.chat.id, username, 0, 'автоматически', expiresAt);
        const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        bot.sendMessage(msg.chat.id, `🎣 ${nick} говорит о рыбалке слишком часто — статус рыбака на 5 минут!`, threadOpts(msg))
          .then(sent => setTimeout(() => bot.deleteMessage(msg.chat.id, sent.message_id).catch(() => {}), 3000))
          .catch(() => {});
      }
    }
  }

  const fisherRow = db.prepare('SELECT expires_at FROM fishers WHERE user_id = ?').get(msg.from.id);
  if (fisherRow) {
    if (fisherRow.expires_at && fisherRow.expires_at * 1000 < Date.now()) {
      db.prepare('DELETE FROM fishers WHERE user_id = ?').run(msg.from.id);
    } else if (msg.text || msg.sticker) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      bot.sendMessage(msg.chat.id, `🎣 ${nick}: 🐟🐟🐟🐟🐟🐟🐟🐟🐟🐟`, threadOpts(msg))
        .then(sent => setTimeout(() => bot.deleteMessage(msg.chat.id, sent.message_id).catch(() => {}), 3000))
        .catch(() => {});
      return;
    }
  }
  const molchunRow = db.prepare('SELECT expires_at FROM molchuns WHERE user_id = ?').get(msg.from.id);
  if (molchunRow) {
    if (molchunRow.expires_at && molchunRow.expires_at * 1000 < Date.now()) {
      db.prepare('DELETE FROM molchuns WHERE user_id = ?').run(msg.from.id);
    } else if (msg.text || msg.sticker) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      bot.sendMessage(msg.chat.id, `🤐 ${nick}: 🤐`, threadOpts(msg))
        .then(sent => setTimeout(() => bot.deleteMessage(msg.chat.id, sent.message_id).catch(() => {}), 3000))
        .catch(() => {});
      return;
    }
  }

  // Dimon (старик) — в каждом третьем сообщении добавляем старческие обороты
  const dimonRow = db.prepare('SELECT message_count, dimon_until FROM dimoniacs WHERE user_id = ?').get(msg.from.id);
  if (dimonRow && dimonRow.dimon_until && dimonRow.dimon_until * 1000 < Date.now()) {
    // Timed status (from a crutch hit) expired — lazily clean up, same
    // idiom as getUserInjury's injured_until check elsewhere in this file.
    db.prepare('DELETE FROM dimoniacs WHERE user_id = ?').run(msg.from.id);
  } else if (dimonRow && msg.text && !msg.text.startsWith('/') && !msg.text.startsWith('**')) {
    const newCount = dimonRow.message_count + 1;
    db.prepare('UPDATE dimoniacs SET message_count = ? WHERE user_id = ?').run(newCount, msg.from.id);

    if (newCount % 3 === 0) {
      const oldMans = [
        '*кашель*', 'э-э-э', 'ой батенька', '*кряхтит*', 'е-хе-хе', '*вздыхает*',
        '*присел на пенек*', '*схватился за сердце*', '*потер спину*', '*охнул*',
        '*прихромал*', '*помассировал ноги*', '*согнулся*', '*заболела спина*'
      ];
      // 5% шанс: вместо обычного старческого оборота — конфузная фраза
      const dimonSpecials = ['пукнул', 'испортил воздух', 'описался', 'уснул'];
      const suffix = Math.random() < 0.05
        ? `*${dimonSpecials[Math.floor(Math.random() * dimonSpecials.length)]}*`
        : oldMans[Math.floor(Math.random() * oldMans.length)];
      const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `🧓 ${nick}: ${msg.text}\n${suffix}`, threadOpts(msg)).catch(() => {});
      return;
    }
  }

  // --- DedoVirus.2026: cough / infection / stage change / procedure side effects ---
  if (msg.text && !msg.text.startsWith('/') && !msg.text.startsWith('**')) {
    const virusRow = getVirusRow(msg.from.id);
    const quarantineActive = isQuarantineActive();
    let virusText = msg.text;
    let virusModified = false;
    let virusCoughed = false;

    // topor sorted last: its full-text replacement should win over any earlier
    // ukol/klizma append (talking nonsense overrides an appended pain/gas phrase,
    // not the other way around) rather than depending on unspecified DB row order
    const virusProcedureTypes = getActiveVirusProcedureTypes(msg.from.id).sort((a) => (a === 'topor' ? 1 : -1));
    // massage soothes what it treats fully (own cough symptoms, below) but only
    // partially dulls other procedures' unrelated side effects (50% per roll)
    const massaged = virusProcedureTypes.includes('massage');
    for (const type of virusProcedureTypes) {
      if (Math.random() < SIDE_EFFECT_CHANCE) {
        const hiddenByMassage = massaged && Math.random() < 0.5;
        if (!hiddenByMassage) {
          if (type === 'ukol') { virusText += `\n${pick(VIRUS_UKOL_PHRASES)}`; virusModified = true; }
          else if (type === 'klizma') { virusText += `\n${pick(VIRUS_KLIZMA_PHRASES)}`; virusModified = true; }
          else if (type === 'topor') { virusText = pick(VIRUS_TOPOR_PHRASES); virusModified = true; }
        }
      }
    }

    if (virusRow && !virusRow.immune) {
      const newCount = virusRow.message_count + 1;
      const newEnergy = Math.min(100, virusRow.energy + 1);
      db.prepare('UPDATE virus_infections SET message_count = ?, energy = ? WHERE user_id = ?').run(newCount, newEnergy, msg.from.id);
      if (newEnergy === 100 && virusRow.energy < 100) {
        bot.sendMessage(msg.chat.id, `⚡ ${virusNick} накопил(а) 100 энергии — теперь можно попробовать /immune!`, threadOpts(msg)).catch(() => {});
      }

      const every = VIRUS_COUGH_EVERY[virusRow.stage] || VIRUS_COUGH_EVERY[3];
      if (newCount % every === 0 && Math.random() < COUGH_CHANCE) {
        if (!massaged) {
          virusCoughed = true;
          virusModified = true;
        }

        const isZombie = virusRow.strain === 'beta' && virusRow.stage === 4;
        let suffix;
        if (isZombie) suffix = pick(VIRUS_SEXZOMBIE_PHRASES);
        else if (virusRow.stage === 1) suffix = VIRUS_STAGE1_PHRASE;
        else if (virusRow.stage === 3 && Math.random() < 0.05) suffix = `*${pick(VIRUS_STAGE3_EXTRAS)}*`;
        else suffix = pick(VIRUS_STAGE2_PHRASES);
        if (!massaged) virusText += `\n${suffix}`;

        let anyInfected = false;
        for (const entry of virusPriorRecent) {
          const existingRow = getVirusRow(entry.userId);
          if (existingRow) {
            const canMutate = entry.userId !== msg.from.id && virusRow.strain === 'alpha' && virusRow.stage === 3 && existingRow.strain === 'alpha';
            if (canMutate && Math.random() < VIRUS_MUTATION_CHANCE * (quarantineActive ? VIRUS_QUARANTINE_RISK_MULTIPLIER : 1)) {
              db.prepare(
                'INSERT OR REPLACE INTO virus_infections (user_id, chat_id, username, stage, is_patient_zero, immune, message_count, strain, added_by, added_by_name) VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?, ?)'
              ).run(entry.userId, msg.chat.id, entry.username, 'beta', msg.from.id, virusNick);
              bot.sendMessage(msg.chat.id, `🧬 ${entry.username} подхватил(а) МУТИРОВАВШИЙ штамм от ${virusNick}! Старый иммунитет к DedoVirus.2026 больше не защищает!`, threadOpts(msg)).catch(() => {});
            }
            continue;
          }
          if (Math.random() < INFECT_CHANCE * (quarantineActive ? VIRUS_QUARANTINE_RISK_MULTIPLIER : 1)) {
            anyInfected = true;
            db.prepare(
              'INSERT OR REPLACE INTO virus_infections (user_id, chat_id, username, stage, is_patient_zero, immune, message_count, added_by, added_by_name) VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?)'
            ).run(entry.userId, msg.chat.id, entry.username, msg.from.id, virusNick);
            bot.sendMessage(msg.chat.id, `🦠 ${entry.username} заразился(-ась) от ${virusNick}!`, threadOpts(msg)).catch(() => {});
          }
        }
        if (!massaged) virusText += `\n${anyInfected ? pick(VIRUS_COUGH_SPREAD_PHRASES) : pick(VIRUS_COUGH_CONTAINED_PHRASES)}`;

        if (!virusRow.is_patient_zero && !isZombie) {
          const improveChance = BASE_IMPROVE_CHANCE * (quarantineActive ? VIRUS_QUARANTINE_IMPROVE_MULTIPLIER : 1) + getVirusProcedureBonus(msg.from.id);
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
      }
    }

    if (virusModified) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `${virusCoughed ? '🦠 ' : ''}${virusNick}: ${virusText}`, threadOpts(msg)).catch(() => {});
      return;
    }
  }

  // Sticker OCR — only static stickers (.webp), skip animated/video
  if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
    const stickerText = await recognizeSticker(msg.sticker.file_id);
    if (stickerText) {
      const { replaced } = filterProfanity(stickerText, '');
      if (replaced) {
        const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        let aRow = db.prepare('SELECT animal, animal_until FROM animals WHERE user_id = ?').get(msg.from.id);
        if (aRow && aRow.animal_until && aRow.animal_until * 1000 < Date.now()) {
          db.prepare('DELETE FROM animals WHERE user_id = ?').run(msg.from.id);
          aRow = null;
        }
        const eRow = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(msg.from.id);
        const pRow = db.prepare('SELECT 1 FROM podhalims WHERE user_id = ?').get(msg.from.id);
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        let reply;
        if (aRow) {
          const { emoji, sound } = ANIMALS[aRow.animal] || ANIMALS.pig;
          reply = `${emoji} ${nick}: ${sound}`;
        } else if (pRow) {
          reply = `🫦 ${nick}: ${randomCompliment()}`;
        } else if (eRow) {
          reply = `🎨 ${nick}: ${randomCompliment()}`;
        } else {
          reply = `${nick}, стикер с матом удалён 🤬`;
        }
        bot.sendMessage(msg.chat.id, reply, threadOpts(msg)).catch(() => {});
        return;
      }
    }
    return;
  }

  const estetRow = db.prepare('SELECT 1 FROM estets WHERE user_id = ?').get(msg.from.id);
  const podhalimRow = db.prepare('SELECT 1 FROM podhalims WHERE user_id = ?').get(msg.from.id);
  let animalRow = db.prepare('SELECT animal, animal_until FROM animals WHERE user_id = ?').get(msg.from.id);
  if (animalRow && animalRow.animal_until && animalRow.animal_until * 1000 < Date.now()) {
    db.prepare('DELETE FROM animals WHERE user_id = ?').run(msg.from.id);
    animalRow = null;
  }
  const ramzan = db.prepare('SELECT 1 FROM ramzans WHERE user_id = ?').get(msg.from.id);

  if ((estetRow || podhalimRow || animalRow || ramzan) && msg.text) {
    let text = msg.text;
    let modified = false;
    const prefixParts = [];

    if (estetRow) {
      const { text: filtered, replaced } = filterProfanityEstet(text);
      if (replaced) { text = filtered; modified = true; prefixParts.push('🎨'); }
    }

    if (podhalimRow) {
      const { text: filtered, replaced } = filterProfanityPodhalim(text);
      if (replaced) { text = filtered; modified = true; prefixParts.push('🫦'); }
    }

    if (animalRow) {
      const { emoji, sound } = ANIMALS[animalRow.animal] || ANIMALS.pig;
      const filtered = filterProfanity(text, sound);
      if (filtered.replaced) { text = filtered.text; modified = true; prefixParts.push(emoji); }
    }

    if (ramzan) {
      text = applyRamzan(text);
      modified = true;
    }

    if (modified) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      const prefix = prefixParts.length ? prefixParts.join('') + ' ' : '';
      bot.sendMessage(msg.chat.id, `${prefix}${nick}: ${text}`, threadOpts(msg)).catch(() => {});
    }
  }
});

// --- Chat ID lookup (no admin gate — not sensitive info, and requiring
// real Telegram admin/creator status here just meant a silent no-op
// with zero feedback for anyone who wasn't one) ---
bot.onText(/\/chatid\b/, (msg) => {
  bot.sendMessage(msg.chat.id, `chat_id: ${msg.chat.id}`, threadOpts(msg)).catch(() => {});
});

// --- Help ---
// Split into one index command plus a command per section — the combined
// single-message /help this replaced rendered to 4427 characters, over
// Telegram's 4096 hard limit for sendMessage, so it was silently failing
// in production (no .catch() on that call either). Each section below is
// comfortably under the limit on its own; PvP, the largest, renders to
// ~3000.
bot.onText(/\/help\b/, (msg) => {
  const text = [
    'Разделы команд — выбери нужный:',
    '/helpstatus — статусы для юмора (ответом на сообщение) и их отмена',
    '/helpmute — мут',
    '/helpmisc — прочие команды (дайс, попытка, список статусов/админов)',
    '/helppvp — PvP: бои, оружие, эликсиры, характеристики',
    '/helpvirus — DedoVirus.2026 (эпидемия)',
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, threadOpts(msg)).catch(() => {});
});

bot.onText(/\/helpstatus\b/, (msg) => {
  const text = [
    'Статусы — ответ на сообщение пользователя:',
    '/pig /cat /fox /dog /cow /donkey — статус животного (мат → звук)',
    '/ramzan — добавляет "Дон" после каждого 3-го слова (стакуется)',
    '/fisher — рыбак: сообщения = 🐟x10, удаляются через 3с (5 мин)',
    '/estet — эстет: оскорбления → комплименты, мат → значения из Даля',
    '/podhalim — подхалим: любой мат → комплимент',
    '/molchun [мин] — молчун: сообщения → 🤐, удаляются через 3с (по умол. 5 мин)',
    '/human — снять все статусы',
    '',
    'Отмена статусов:',
    '/unpig /uncat /unfox /undog /uncow /undonkey',
    '/unramzan /unfisher /unestet /unpodhalim /unmolchun',
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, threadOpts(msg)).catch(() => {});
});

bot.onText(/\/helpmute\b/, (msg) => {
  const text = [
    'Мут:',
    '/mute [10m|2h|1d] — замутить (ответ на сообщение)',
    '/unmute — размутить',
    '/mutes — список замутов',
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, threadOpts(msg)).catch(() => {});
});

bot.onText(/\/helpmisc\b/, (msg) => {
  const text = [
    'Прочее:',
    '/animals — список всех активных статусов',
    '/names — список администраторов',
    '/try [текст] — попытка (0–100)',
    '/dice [максимум] — кубик',
    '** [текст] — действие от третьего лица',
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, threadOpts(msg)).catch(() => {});
});

bot.onText(/\/helppvp\b/, (msg) => {
  const text = [
    'PvP:',
    '/me — здоровье, энергия, травма, укрытие и статистика (крит. ударов нанесено, травм нанесено, время в чулане/вне его)',
    '/warrior — стать воином (один раз навсегда); без этого ни атаковать, ни быть целью /kick нельзя; сразу даёт 300 опыта (3 очка) на характеристики — вложить через /levelup',
    '/warriors — список всех воинов: здоровье, иконки оружия в руках, уровень',
    '/pick — забрать ящик из последней волны, упавшей на арену (раз в 3 часа, кроме 00:00-08:00; 5 ящиков: 2 эликсира здоровья, 2 эликсира энергии, ржавый нож ×1.5 урона на 3 часа; только в чате «Поединки», только воинам, 1 ящик в одни руки за волну)',
    '/inventory — сколько накоплено эликсиров (см. /pick)',
    '/restore — выпить эликсир здоровья: +100 ХП, не выше максимума',
    '/recharge — выпить эликсир энергии: полное восстановление',
    '/give @username — передать эликсир или оружие другому воину (с его подтверждением)',
    '/kick @юзернейм (или ответом) — ударить подручными средствами; /kick1, /kick2, /kick3 — конкретным оружием по номеру слота (см. /me), если в слоте пусто — тоже подручными (работает только в чате «Поединки»; нужно быть воином — и атакующему, и цели, см. /warrior; без ответного удара; урон 1-20 × сила и множитель оружия, попадание зависит от точности, после попадания жертва может увернуться (базово 50%, зависит от её ловкости); критический удар — травма на 2-24 часа (голова -10% точности, рука -10% урона, нога -10% уворота у пострадавшего — не блокирует атаку), 0 здоровья — попадает в больничку (недоступен для удара, регенерация ×2, пока не наберёт 30 ХП; может выйти раньше сам, атаковав) + если у жертвы было оружие, добивший получает кнопки забрать/оставить (при нескольких — выбор какое; сам захват — ещё 50/50, жертва может вцепиться и не отдать); тратит 1 энергию из 10, восстановление зависит от выносливости; пауза между ударами зависит от ловкости, действует отдельно на каждое оружие/на голые руки; ровно 100/100 — не увернуться, сразу сносит всю жизнь цели; ровно 0/100 с оружием в руке — роняет его, первый написавший в чат кроме тебя подбирает; удачный удар даёт опыт — см. /levelup)',
    '/hide [часы] — спрятаться в чулане от /kick на N часов (по умолчанию 1); чулан вмещает только 5 человек — если он полон, новый прячущийся случайно выкидывает оттуда кого-то одного; тратит N энергии сразу, при недостатке энергии — отказ; своя атака снимает прятки и на 20 минут блокирует повторный /hide; сама команда — раз в 20 минут',
    '/find — список всех бойцов: 🏥 сначала те, кто в больничке, затем 🐰 те, кто в чулане (с оставшимся временем), затем ⚔️ остальные',
    '/levelup точность|сила|ловкость|выносливость — тратит 1 очко характеристики (1 очко = каждые 100 опыта; опыт: +1 за удачный удар, +5 за крит, +15 за 100/100)',
    '/kuniFun — попытка получить бафф +50% крит на /kick, 10 мин (50% шанс успеха; тратит 2 энергии в любом случае; кулдаун = 10 мин в любом случае)',
    '/kuniAlia — попытка получить бафф +50% уклонение от /kick, 10 мин (50% шанс успеха; тратит 2 энергии в любом случае; кулдаун = 10 мин в любом случае)',
    '/kuniTama — попытка получить бафф +25% крит и +25% уклонение, 10 мин (50% шанс успеха; тратит 2 энергии в любом случае; кулдаун = 10 мин в любом случае)',
    '/defend — встать в защитную стойку на 30 мин: +25 к увороту, −40% входящего урона (только обычный урон, не нат.100/жопу морковкой); атака снимает стойку; тратит 2 энергии, кулдаун = сама стойка',
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, threadOpts(msg)).catch(() => {});
});

bot.onText(/\/helpvirus\b/, (msg) => {
  const text = [
    'DedoVirus.2026 (эпидемия):',
    '/0patient — назначить нулевого пациента (ответ на сообщение, админ)',
    '/epidemic — список заражённых: стадия, штамм, процедуры, иммунные',
    '/cure — вылечить принудительно (ответ на сообщение, админ)',
    '/endvirus — сбросить эпидемию целиком (админ)',
    '/patient — своя карточка больного (админ ответом — карточка любого)',
    '/immune — попытка самоизлечения при 100 энергии (50/50)',
    '/ukol /klizma /topor /massage — процедуры (ответ на сообщение, админ)',
    '/quarantine — карантин на 24ч: риск заражения ×0.4, шанс выздоровления ×2 (админ)',
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, threadOpts(msg)).catch(() => {});
});

// --- Game commands ---
bot.onText(/\/[Tt]ry(?: (.+))?/, async (msg, match) => {
  const text = match[1] || msg.reply_to_message?.text;
  if (!text) return;
  const num = Math.floor(Math.random() * 101);
  const username = await getDisplayName(msg);
  const outcome = num < 50 ? '❌ неудачно' : '✅ удачно';
  const replyTo = msg.reply_to_message?.message_id;
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  bot.sendMessage(msg.chat.id, `${username} — ${text} ${outcome}: ${num}/100`, threadOpts(msg, replyTo ? { reply_to_message_id: replyTo } : {}));
});

bot.onText(/\/dice(?: (\d+))?/, async (msg, match) => {
  const replyText = msg.reply_to_message?.text || '';
  const maxFromReply = replyText.match(/\d+/)?.[0];
  const max = parseInt(match[1] || maxFromReply || '100');
  const num = Math.floor(Math.random() * (max + 1));
  const username = await getDisplayName(msg);
  const replyTo = msg.reply_to_message?.message_id;
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  bot.sendMessage(msg.chat.id, `${username} — 🎲 ${num}/${max}`, threadOpts(msg, replyTo ? { reply_to_message_id: replyTo } : {}));
});

bot.onText(/^\*\*(?: (.+))?/, async (msg, match) => {
  const text = match[1] || msg.reply_to_message?.text;
  if (!text) return;
  const username = await getDisplayName(msg);
  const replyTo = msg.reply_to_message?.message_id;
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  bot.sendMessage(msg.chat.id, `${username} 🟣 <b><i>${text}</i></b>`, threadOpts(msg, { parse_mode: 'HTML', ...(replyTo ? { reply_to_message_id: replyTo } : {}) })).catch(() => {});
});

const IMAGES_DIR = path.join(__dirname, 'images');

bot.onText(/\/msg\s+"([^"]+)"\s+"([^"]*)"/, async (msg, match) => {
  const [, fileName, text] = match;
  const filePath = path.resolve(IMAGES_DIR, fileName);
  if (!filePath.startsWith(IMAGES_DIR + path.sep) || !fs.existsSync(filePath)) {
    return bot.sendMessage(msg.chat.id, text, threadOpts(msg));
  }
  bot.sendPhoto(msg.chat.id, filePath, { caption: text, ...threadOpts(msg) }).catch((err) => {
    console.error('sendPhoto error:', err.message);
    bot.sendMessage(msg.chat.id, text, threadOpts(msg));
  });
});

const reactionRollsSeen = new Set(); // "reactorId:chatId:messageId", one roll per pair ever, capped at 1000

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

  const rollKey = `${reactorId}:${reaction.chat.id}:${reaction.message_id}`;
  if (reactionRollsSeen.has(rollKey)) return;
  reactionRollsSeen.add(rollKey);
  if (reactionRollsSeen.size > 1000) reactionRollsSeen.delete(reactionRollsSeen.values().next().value);

  const stage = reactorRow.is_patient_zero ? 3 : reactorRow.stage;
  const baseChance = REACTION_INFECT_CHANCE[stage] || REACTION_INFECT_CHANCE[3];
  const chance = baseChance * (isQuarantineActive() ? VIRUS_QUARANTINE_RISK_MULTIPLIER : 1);
  if (Math.random() >= chance) return;

  const reactorNick = reaction.user.username ? `@${reaction.user.username}` : reaction.user.first_name;
  db.prepare(
    'INSERT OR REPLACE INTO virus_infections (user_id, chat_id, username, stage, is_patient_zero, immune, message_count, added_by, added_by_name) VALUES (?, ?, ?, 1, 0, 0, 0, ?, ?)'
  ).run(author.userId, reaction.chat.id, author.username, reactorId, reactorNick);
  bot.sendMessage(reaction.chat.id, `🦠 ${author.username} заразился(-ась) от ${reactorNick}!`, author.threadId ? { message_thread_id: author.threadId } : {}).catch(() => {});
});

// Tracks /give Stage-2 offer messages already resolved (accepted or
// declined), keyed by "chatId:messageId" (message_id is only unique
// within a chat, not globally, and /give is usable in any chat) — without
// this, two rapid clicks on the same "Принять" button would each
// independently pass the elixir count check and double-transfer a
// stackable item. Capped like reactionRollsSeen to avoid unbounded growth.
const resolvedGiveOffers = new Set();
const MAX_RESOLVED_GIVE_OFFERS = 1000;

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

  // /levelup's stat buttons — acts on whoever clicked (query.from.id),
  // not whoever originally ran /levelup: every user has their own
  // independent pvp_stats row, so there's nothing to authorize against,
  // unlike the weapon-steal buttons below. Message stays editable with
  // a fresh keyboard as long as points remain, so repeated clicks on
  // the same message keep spending without needing to re-run the
  // command each time.
  if (data.startsWith('levelup:')) {
    const statColumn = data.slice('levelup:'.length);
    if (!LEVELUP_STAT_LABELS[statColumn]) {
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }
    const userId = query.from.id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const stats = getStats(userId);
    const available = Math.floor(stats.xp / 100) - (stats.accuracy + stats.strength + stats.agility + stats.endurance);
    if (available <= 0) {
      const needed = 100 - (stats.xp % 100);
      await bot.editMessageText(
        `${actorLabel}, очков больше нет — ещё ${needed} XP до следующего.`,
        { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }
      ).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }
    const newValue = spendLevelupPoint(userId, statColumn);
    const remaining = available - 1;
    const freshStats = getStats(userId);
    const text = `${actorLabel}, ${LEVELUP_STAT_LABELS[statColumn]} теперь ${newValue}. Доступно очков: ${remaining}. Точность ${freshStats.accuracy} | Сила ${freshStats.strength} | Ловкость ${freshStats.agility} | Выносливость ${freshStats.endurance}.`;
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: remaining > 0 ? levelupKeyboard() : { inline_keyboard: [] },
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id, { text: `+1 ${LEVELUP_STAT_LABELS[statColumn]}!` }).catch(() => {});
  }

  // /give Stage 1 -> Stage 2: sender picked an item. Re-verify it's still
  // available (they may have spent/given it away while the keyboard sat
  // unclicked), then post a fresh message addressed to the receiver with
  // a 5-minute expiry embedded in callback_data (same lazy-expiry idiom
  // as hidden_until/mutes/the knife's own expires_at — no timer needed).
  if (data.startsWith('gv_i:')) {
    const [, senderIdStr, targetIdStr, ...itemParts] = data.split(':');
    const senderId = Number(senderIdStr);
    const targetId = Number(targetIdStr);
    const itemType = itemParts.join(':');

    if (query.from.id !== senderId) {
      return bot.answerCallbackQuery(query.id, { text: 'Это не твоё предложение', show_alert: true }).catch(() => {});
    }

    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const editOpts = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

    let available = false;
    if (itemType === 'elixir:health') {
      const row = db.prepare('SELECT health_elixirs FROM pvp_stats WHERE user_id = ?').get(senderId);
      available = !!row && row.health_elixirs > 0;
    } else if (itemType === 'elixir:energy') {
      const row = db.prepare('SELECT energy_elixirs FROM pvp_stats WHERE user_id = ?').get(senderId);
      available = !!row && row.energy_elixirs > 0;
    } else {
      const weaponKey = itemType.slice('weapon:'.length);
      const row = db.prepare(
        "SELECT 1 FROM weapon_ownership WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
        "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
      ).get(weaponKey, senderId);
      available = !!row;
    }
    if (!available) {
      await bot.editMessageText('Этого у тебя уже нет.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    await bot.editMessageText(`${actorLabel} предлагает ${itemLabel(itemType)}. Ожидание ответа...`, editOpts).catch(() => {});

    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(targetId);
    const targetLabel = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${targetId}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 300;

    bot.sendMessage(
      chatId,
      `🎁 ${actorLabel} хочет передать тебе ${itemLabel(itemType)}, ${targetLabel}. Принимаешь?`,
      threadOpts(query.message, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Принять', callback_data: `gv_y:${senderId}:${targetId}:${itemType}:${expiresAt}` },
            { text: 'Отклонить', callback_data: `gv_n:${senderId}:${targetId}:${itemType}:${expiresAt}` },
          ]],
        },
      })
    ).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  // /give Stage 2: receiver accepts or declines. Nothing was reserved at
  // Stage 1, so gv_y re-verifies and transfers atomically right here;
  // gv_n just leaves everything as-is.
  if (data.startsWith('gv_y:') || data.startsWith('gv_n:')) {
    const [action, senderIdStr, targetIdStr, ...rest] = data.split(':');
    const senderId = Number(senderIdStr);
    const targetId = Number(targetIdStr);
    const expiresAt = Number(rest[rest.length - 1]);
    const itemType = rest.slice(0, -1).join(':');

    if (query.from.id !== targetId) {
      return bot.answerCallbackQuery(query.id, { text: 'Это предложение не тебе', show_alert: true }).catch(() => {});
    }

    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    const resolvedKey = `${chatId}:${messageId}`;
    if (resolvedGiveOffers.has(resolvedKey)) {
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }
    resolvedGiveOffers.add(resolvedKey);
    if (resolvedGiveOffers.size > MAX_RESOLVED_GIVE_OFFERS) resolvedGiveOffers.delete(resolvedGiveOffers.values().next().value);

    const editOpts = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };
    const senderKnown = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(senderId);
    const senderLabel = senderKnown ? (senderKnown.username ? `@${senderKnown.username}` : senderKnown.first_name) : `игрок ${senderId}`;
    const targetLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

    if (action === 'gv_n') {
      await bot.editMessageText(`Отклонено — предмет остался у ${senderLabel}.`, editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > expiresAt) {
      await bot.editMessageText('Предложение просрочено.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    let transferred = false;
    if (itemType === 'elixir:health') {
      const spent = db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs > 0 RETURNING health_elixirs').get(senderId);
      if (spent) {
        ensureStatsRow(targetId);
        db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?').run(targetId);
        transferred = true;
      }
    } else if (itemType === 'elixir:energy') {
      const spent = db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs - 1 WHERE user_id = ? AND energy_elixirs > 0 RETURNING energy_elixirs').get(senderId);
      if (spent) {
        ensureStatsRow(targetId);
        db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs + 1 WHERE user_id = ?').run(targetId);
        transferred = true;
      }
    } else {
      const weaponKey = itemType.slice('weapon:'.length);
      const result = db.prepare(
        "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? " +
        "WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
        "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
      ).run(targetId, query.from.username, weaponKey, senderId);
      transferred = result.changes > 0;
    }

    if (!transferred) {
      await bot.editMessageText('У отправителя этого уже нет.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    await bot.editMessageText(`✅ ${senderLabel} передал(а) ${itemLabel(itemType)} игроку ${targetLabel}!`, editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;

  const [action, attackerIdStr, victimIdStr, weaponKey] = data.split(':');
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

  // weaponKey pins down exactly which button was pressed — re-verify live
  // that it's still on the victim (not moved by a crit-steal or a
  // different button click in the meantime) rather than trusting the
  // snapshot the offer was built from.
  const victimId = Number(victimIdStr);
  // Same expiry filter as getWeaponsFor — without it, a knife that
  // expired in the gap between the offer being posted and this click
  // could still be "stolen" here despite already being invisible
  // everywhere else (getWeaponsFor, /me, /find, /warriors).
  const row = db.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? AND weapon_key = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
  ).get(victimId, weaponKey);
  if (!row) {
    await bot.editMessageText('Этого оружия там уже нет — кто-то опередил.', editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  const def = WEAPON_DEFS[row.weapon_key];
  const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

  // 50/50 grip roll — even with the weapon confirmed still on the
  // victim, the downed victim gets one last chance to hang on to it
  // instead of the grab always succeeding outright.
  if (Math.random() < 0.5) {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(victimId);
    const victimLabel = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${victimId}`;
    await bot.editMessageText(`🤜 ${actorLabel} пытается вырвать ${def.accusative}, но ${victimLabel} вцепляется в неё мёртвой хваткой — не отдаёт!`, editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  db.prepare(
    "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?"
  ).run(query.from.id, query.from.username, row.weapon_key);
  await bot.editMessageText(`${def.emoji} ${actorLabel} обыскал(а) отключившегося и забрал(а) ${def.accusative}!`, editOpts).catch(() => {});
  bot.answerCallbackQuery(query.id).catch(() => {});
});

// Health regen — this bot's first background timer (no existing setInterval
// to mirror; troll-bot's own backgroundTick is the loose stylistic
// reference: one self-contained function, called on a fixed interval).
// Runs every 10 minutes: (1) hourly HEALTH_REGEN_PER_HOUR trickle, doubled
// while hospitalized (see больничка docs), prorated by elapsed time and
// capped at max_health, for anyone below it — hospitalized_since is
// cleared in the same write the instant regenerated health crosses
// HOSPITAL_EXIT_HEALTH, so it can never go stale via this path; (2) once
// daily at 04:00 server time, a full restore to max_health for everyone
// (also clearing hospitalized_since, for the same reason), guarded by
// health_regen_state.last_full_restore_date so it only fires once per
// calendar day rather than on every tick during the 04:00 hour.
const HEALTH_REGEN_PER_HOUR = 20;
const HEALTH_REGEN_TICK_MS = 10 * 60 * 1000;
// Energy regens on its own fixed cadence (1 point per 20 minutes, no
// proration) rather than health's per-hour rate — simpler since 1 is
// already the smallest unit, so partial-interval gains would always be 0
// anyway.
const ENERGY_REGEN_INTERVAL_SECONDS = 20 * 60;

function healthRegenTick() {
  try {
    const now = Math.floor(Date.now() / 1000);

    const rows = db.prepare('SELECT user_id, health, max_health, last_regen_at, hospitalized_since FROM user_health WHERE health < max_health').all();
    for (const row of rows) {
      const elapsedSeconds = row.last_regen_at ? now - row.last_regen_at : 3600;
      const rate = row.hospitalized_since !== null ? HEALTH_REGEN_PER_HOUR * HOSPITAL_REGEN_MULTIPLIER : HEALTH_REGEN_PER_HOUR;
      const gain = Math.floor((elapsedSeconds / 3600) * rate);
      if (gain > 0) {
        const newHealth = Math.min(row.max_health, row.health + gain);
        const stillHospitalized = row.hospitalized_since !== null && newHealth < HOSPITAL_EXIT_HEALTH;
        db.prepare(
          'UPDATE user_health SET health = ?, last_regen_at = ?, hospitalized_since = ? WHERE user_id = ?'
        ).run(newHealth, now, stillHospitalized ? row.hospitalized_since : null, row.user_id);
      }
    }

    // LEFT JOIN since not every user_health row necessarily has a
    // pvp_stats row yet (ensureStatsRow only fires lazily, on combat
    // actions) — COALESCE defaults a missing row to 0 endurance, same
    // as everywhere else that reads an attribute.
    const energyRows = db.prepare(
      'SELECT uh.user_id, uh.energy, uh.max_energy, uh.last_energy_regen_at, COALESCE(ps.endurance, 0) AS endurance ' +
      'FROM user_health uh LEFT JOIN pvp_stats ps ON ps.user_id = uh.user_id ' +
      'WHERE uh.energy < uh.max_energy'
    ).all();
    for (const row of energyRows) {
      const intervalSeconds = Math.max(MIN_ENERGY_REGEN_INTERVAL_SECONDS, ENERGY_REGEN_INTERVAL_SECONDS * (1 - row.endurance * ENDURANCE_REGEN_SPEEDUP_PER_POINT));
      const elapsedSeconds = row.last_energy_regen_at ? now - row.last_energy_regen_at : intervalSeconds;
      const gain = Math.floor(elapsedSeconds / intervalSeconds);
      if (gain > 0) {
        db.prepare('UPDATE user_health SET energy = MIN(max_energy, energy + ?), last_energy_regen_at = ? WHERE user_id = ?').run(gain, now, row.user_id);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const regenState = db.prepare('SELECT last_full_restore_date FROM health_regen_state WHERE id = 1').get();
    const hour = new Date().getHours();
    if (hour === 4 && regenState.last_full_restore_date !== today) {
      db.prepare('UPDATE user_health SET health = max_health, last_regen_at = ?, hospitalized_since = NULL WHERE health < max_health').run(now);
      db.prepare('UPDATE health_regen_state SET last_full_restore_date = ? WHERE id = 1').run(today);
    }
  } catch (err) {
    console.error('healthRegenTick failed:', err.message);
  }
}
setInterval(healthRegenTick, HEALTH_REGEN_TICK_MS);

// Arena crate drops — every 3 hours (never during 00:00-08:00 server
// time), 5 crates (2 health elixirs, 2 energy elixirs, 1 rusty knife)
// land in the arena chat; /pick further below claims them one at a
// time. Checked on the same 10-minute cadence as healthRegenTick — the
// exact moment within that window isn't meaningful, only "has it been
// >= 3h since the last drop, and are we clear of night hours".
const ARENA_DROP_INTERVAL_MS = 3 * 60 * 60 * 1000;
const ARENA_NIGHT_START_HOUR = 0;
const ARENA_NIGHT_END_HOUR = 8;

function isArenaNightHour() {
  const hour = new Date().getHours();
  return hour >= ARENA_NIGHT_START_HOUR && hour < ARENA_NIGHT_END_HOUR;
}

function arenaTick() {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Knife decay — checked every tick regardless of whether a new drop
    // fires this time, since its 3h timer runs independently of the
    // drop schedule (it started whenever it was last picked up, not
    // whenever the crate wave landed).
    const knifeRow = db.prepare("SELECT owner_user_id, owner_username, expires_at FROM weapon_ownership WHERE weapon_key = 'knife' AND owner_type = 'human'").get();
    if (knifeRow && knifeRow.expires_at && knifeRow.expires_at < now) {
      db.prepare("UPDATE weapon_ownership SET owner_type = 'none', owner_user_id = NULL, owner_username = NULL, expires_at = NULL WHERE weapon_key = 'knife'").run();
      const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(knifeRow.owner_user_id);
      const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${knifeRow.owner_user_id}`;
      bot.sendMessage(ARENA_CHAT_ID, `🔪💨 Ржавый нож у ${label} рассыпался от старости!`).catch(() => {});
    }

    if (isArenaNightHour()) return;
    const state = db.prepare('SELECT last_drop_at, current_batch_id FROM arena_drop_state WHERE id = 1').get();
    const lastDropAt = state.last_drop_at || 0;
    if ((now - lastDropAt) * 1000 < ARENA_DROP_INTERVAL_MS) return;

    const newBatchId = state.current_batch_id + 1;
    // Only 1 knife ever exists at a time (weapon_ownership has exactly
    // one 'knife' row) — since the drop cadence (3h) equals the knife's
    // own decay timer (3h), a new batch landing while the previous
    // knife is still held (or lying fumble-dropped, unclaimed) would
    // otherwise silently steal/overwrite it via /pick's unconditional
    // UPDATE. The decay check above already reverts an expired one to
    // 'none' earlier in this same tick, so re-querying here reflects
    // that immediately — only offer a fresh knife when none currently
    // exists.
    const knifeNow = db.prepare("SELECT owner_type FROM weapon_ownership WHERE weapon_key = 'knife'").get();
    const crateTypes = knifeNow.owner_type === 'none'
      ? ['health_elixir', 'health_elixir', 'energy_elixir', 'energy_elixir', 'knife']
      : ['health_elixir', 'health_elixir', 'energy_elixir', 'energy_elixir'];
    const insertCrate = db.prepare('INSERT INTO arena_crates (batch_id, crate_type, claimed_by) VALUES (?, ?, NULL)');
    const insertBatch = db.transaction((types) => {
      for (const type of types) insertCrate.run(newBatchId, type);
    });
    insertBatch(crateTypes);
    db.prepare('UPDATE arena_drop_state SET last_drop_at = ?, current_batch_id = ? WHERE id = 1').run(now, newBatchId);

    bot.sendMessage(
      ARENA_CHAT_ID,
      '📦☄️ С неба на арену упало 5 ящиков! Внутри: 2 эликсира здоровья, 2 эликсира энергии и ржавый нож. Кто первый напишет /pick — тот и заберёт (только 1 ящик в одни руки).'
    ).catch(() => {});
  } catch (err) {
    console.error('arenaTick failed:', err.message);
  }
}
setInterval(arenaTick, HEALTH_REGEN_TICK_MS);
// First check 1 minute after boot instead of waiting for the first
// 10-minute interval tick — arenaTick's own condition (>= 3h since
// last_drop_at, which starts NULL/treated as 0) already fires an
// immediate real drop on a fresh deploy, this just moves that moment
// up from "up to 10 minutes" to "1 minute". Still fully subject to the
// existing night-hour check, so a deploy during 00:00-08:00 correctly
// waits like any other tick would. Safe to run alongside the interval
// above — arenaTick no-ops on its own if nothing's actually due yet.
setTimeout(arenaTick, 60 * 1000);

// Bleed tick (see applyBleed and every `weapon.key === 'scissors'` call
// site) — 1-minute granularity because the mechanic itself is 1 HP/minute,
// much finer than healthRegenTick's 10-minute cadence, so it needs its own
// interval rather than piggybacking on that one. Every user currently
// bleeding, every minute: if the 20-minute window already elapsed, clear
// it and announce a natural stop; else if they're already at 0 health,
// skip entirely (no point re-spamming a downed target); else deduct 1 HP
// via damageHuman (which already handles the 0-health-mutes floor for
// free) and announce it, then — at most once per 5 minutes, tracked via
// last_bleed_stop_attempt_at — roll a 50/50 to end the bleed early.
const BLEED_TICK_MS = 60 * 1000;
const BLEED_STOP_ROLL_INTERVAL_SECONDS = 5 * 60;
function bleedTick() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare('SELECT user_id, health, bleed_until, bleed_chat_id, last_bleed_stop_attempt_at FROM user_health WHERE bleed_until IS NOT NULL').all();
    for (const row of rows) {
      if (row.bleed_until <= now) {
        db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(row.user_id);
        bot.sendMessage(row.bleed_chat_id, '🩸 Кровотечение остановилось само.').catch(() => {});
        continue;
      }
      if (row.health === 0) continue;
      const before = row.health;
      const after = damageHuman(row.user_id, row.bleed_chat_id, null, 1);
      bot.sendMessage(row.bleed_chat_id, `🩸 Кровотечение: -1 хп (${before} -> ${after})`).catch(() => {});
      if (!row.last_bleed_stop_attempt_at || now - row.last_bleed_stop_attempt_at >= BLEED_STOP_ROLL_INTERVAL_SECONDS) {
        if (Math.random() < 0.5) {
          db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL, last_bleed_stop_attempt_at = ? WHERE user_id = ?').run(now, row.user_id);
          bot.sendMessage(row.bleed_chat_id, '🩸 Кровотечение остановилось.').catch(() => {});
        } else {
          db.prepare('UPDATE user_health SET last_bleed_stop_attempt_at = ? WHERE user_id = ?').run(now, row.user_id);
        }
      }
    }
  } catch (err) {
    console.error('bleedTick failed:', err.message);
  }
}
setInterval(bleedTick, BLEED_TICK_MS);

console.log('Бот запущен...');
