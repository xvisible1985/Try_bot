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
const webAppUrl = process.env.WEB_APP_URL;
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

// Persistent menu button next to the message input, opening tg-web as a
// Telegram Mini App — idempotent (safe to call on every boot; Telegram
// just keeps the setting if unchanged). menu_button must be
// JSON-stringified here: node-telegram-bot-api only auto-serializes
// `reply_markup` for form fields (see its _fixReplyMarkup), not
// menu_button, so passing a raw object would silently form-encode wrong.
if (webAppUrl) {
  bot.setChatMenuButton({
    menu_button: JSON.stringify({ type: 'web_app', text: 'Боец', web_app: { url: webAppUrl } }),
  })
    // Logs the actual URL on success — cheap way to eyeball-verify the
    // right site is wired up at deploy time. This is also the one place
    // to check that TG_BOT_TOKEN in tg-web's own .env is really the same
    // bot as this one: initData is signed per-bot, so if the two tokens
    // ever diverge, tg-web's auth silently 403s for everyone with no
    // crash anywhere — nothing else surfaces that mismatch.
    .then(() => console.log('menu button set, web_app url:', webAppUrl))
    .catch(err => console.error('setChatMenuButton failed:', err.message));
} else {
  console.error('WEB_APP_URL not set — skipping setChatMenuButton');
}

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
// Timed animal status column — NULL means the existing PERMANENT status
// set by /pig, /cat, /fox etc. (unchanged). No longer written by any
// weapon (carrot's timed cat/fox effect was removed), kept only because
// the expiry-check reads further down still handle a timed value if one
// were ever set some other way.
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
// /tree (see the PvP section below, and WEAPON_DEFS.claws) — a second,
// independent "can't be targeted" status alongside hidden_until, only
// reachable by whoever currently holds когти Лимы. Deliberately its own
// column rather than reusing hidden_until: /hide's чулан has a 5-person
// capacity and its own 20-min self-cooldown, neither of which apply
// here, and the two are meant to stack (a person can be both hidden and
// treed at once) rather than share one timer.
try {
  db.exec('ALTER TABLE user_health ADD COLUMN tree_until INTEGER');
} catch {}
// Ссаные тапки's 20%-on-hit "scare" proc (see performKick's
// weapon.key === 'tapki' block) — unlike every other status here, this
// one is scoped to a SPECIFIC person (scared_of_user_id), not "can't be
// attacked by anyone": the scared person just can't swing at that one
// person for a few minutes, everyone else is still fair game. See
// isScaredOf below.
for (const [column, def] of [['scared_of_user_id', 'INTEGER'], ['scared_until', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
  } catch {}
}
// Bat's 30%-on-hit stun (see performKick's weapon.key === 'bat' block) —
// while active, the stunned person's own /kick refuses outright, same
// idiom as isHidden below (a plain lazy timestamp read, no separate
// cleanup needed).
try {
  db.exec('ALTER TABLE user_health ADD COLUMN stunned_until INTEGER');
} catch {}
// /fuck's paralysis (see isParalyzed below and the /fuck command itself)
// — same lazy-timestamp idiom as stunned_until, but blocks BOTH sides of
// combat (can't attack, can't be attacked) rather than just attacking.
try {
  db.exec('ALTER TABLE user_health ADD COLUMN paralyzed_until INTEGER');
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

// Warrior wallets — see docs/superpowers/specs/2026-08-25-wallet-design.md.
// No spending mechanic exists yet; this is purely a balance, gained via
// /warrior registration and knockout-loot robbery. Same ALTER idiom as
// the elixir columns above.
for (const [column, def] of [['coins', 'INTEGER NOT NULL DEFAULT 0']]) {
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
// table), regenerating 1 per 10 minutes up to max_energy. Same
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

// Daily warrior coin payout — see
// docs/superpowers/specs/2026-08-25-daily-payout-design.md. Same
// singleton-row idiom as last_full_restore_date above, just a second
// independent date guard on the same row.
for (const [column, def] of [['last_daily_payout_date', 'TEXT']]) {
  try { db.exec(`ALTER TABLE health_regen_state ADD COLUMN ${column} ${def}`); } catch {}
}

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

// Knife instances — see
// docs/superpowers/specs/2026-08-25-knife-multi-instance-design.md.
// Unlike every weapon in weapon_ownership (weapon_key is a PK, so at
// most one of each can ever exist), a player can hold several knives
// at once, each independently decaying 3h after its own acquisition —
// one row per physical knife. is_dropped/dropped_chat_id mirror
// weapon_ownership's own fumble-drop convention exactly (owner_user_id
// repurposed to "who dropped it" while is_dropped=1, so they can't
// immediately re-pick their own).
db.exec(`
  CREATE TABLE IF NOT EXISTS owned_knives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    owner_username TEXT,
    is_dropped INTEGER NOT NULL DEFAULT 0,
    dropped_chat_id INTEGER,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
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
// Тапки's temporary "ссаные" state (see /piss_tapki and isTapkiSoiled
// below) — only ever meaningful for weapon_key = 'tapki', NULL for every
// other row forever, same sparse-column idiom as expires_at above (only
// meaningful for 'knife'... now retired there too, but the idiom holds).
try {
  db.exec('ALTER TABLE weapon_ownership ADD COLUMN tapki_soiled_until INTEGER');
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
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('claws', 'Tenek_82', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('tapki', 'Original_Pofig', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('katana', 'GiviTata', 'human', NULL, NULL)").run();
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

// Generic key-value settings store — not tied to any one feature, so
// future on/off-style flags can reuse this instead of another ALTER +
// migration. Currently holds only 'pvp_paused' (see /pvpon, /pvpoff,
// and isPvpPaused below).
db.exec('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)');
function isPvpPaused() {
  const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'pvp_paused'").get();
  return !!row && row.value === '1';
}

// One-time: carry over a currently-actively-held knife (if any) into
// its own owned_knives row, then retire weapon_ownership's singleton
// knife row entirely — going forward, /pick, the shop, and every other
// knife-touching site use owned_knives exclusively. A fumble-dropped-
// but-unclaimed knife at migration time is intentionally NOT carried
// over (an edge case not worth the extra complexity) — it simply
// ceases to exist, same as if it had fully decayed.
runOnce('2026-08-25-knife-multi-instance-migration', () => {
  const existing = db.prepare("SELECT owner_user_id, owner_username, expires_at FROM weapon_ownership WHERE weapon_key = 'knife' AND owner_type = 'human'").get();
  if (existing) {
    db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)')
      .run(existing.owner_user_id, existing.owner_username, Math.floor(Date.now() / 1000), existing.expires_at);
  }
  db.exec("DELETE FROM weapon_ownership WHERE weapon_key = 'knife'");
});

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

// /fuck's paralysis — same lazy-timestamp idiom as isStunned, but
// checked on BOTH sides of every combat interaction (attacker AND
// target, human AND goblin) since a paralyzed player can neither attack
// nor be attacked, unlike a stun which only blocks attacking.
function isParalyzed(userId) {
  const row = db.prepare('SELECT paralyzed_until FROM user_health WHERE user_id = ?').get(userId);
  return !!row && !!row.paralyzed_until && row.paralyzed_until * 1000 > Date.now();
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

// Appended after every дилдо hole outcome except the head stun (see
// weapon.key === 'dildo' in performKick) — one random teasing line per hit.
const DILDO_INSULTS = [
  'Даже неодушевлённый предмет справляется с тобой лучше, чем ты сам!',
  'Ты покраснел сильнее, чем этот дилдо!',
  'Похоже, это стало кульминацией твоего дня.',
  'Вот это ты словил — по самые уши, в прямом смысле.',
  'Реакция была подозрительно довольной для такого удара.',
  'Даже оранжевый цвет тебе не идёт так, как этот позор.',
];

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
const MIN_ENERGY_REGEN_INTERVAL_SECONDS = 300;  // floor at 5 min (base is 10 min)
const XP_PER_HIT = 1;
const XP_PER_CRIT = 5;
const XP_PER_NAT100 = 15;
const HOSPITAL_EXIT_HEALTH = 30;      // больничка releases you once health reaches this
const HOSPITAL_REGEN_MULTIPLIER = 2;  // regen rate while hospitalized, vs. the normal HEALTH_REGEN_PER_HOUR baseline
const HOSPITAL_MIN_DISCHARGE_HEALTH = 5; // minimum health to leave больничка early by attacking
const DEFEND_DURATION_MS = 30 * 60 * 1000;
const DEFEND_ENERGY_COST = 2;
const DEFEND_DODGE_BONUS = 25;      // added to the defender's opposed-roll score, on top of everything else
const DEFEND_DAMAGE_REDUCTION = 0.4; // incoming graduated damage ×(1 - 0.4); does NOT apply to nat-100/carrot-ass/axe-shave

// 20-minute чулан lockout for anyone who actually lands a hit (see
// /hide below) — in-memory, same idiom as hideCooldowns/pvpCooldowns,
// doesn't need to survive a restart.
const combatLockouts = new Map();
const NO_HIDE_AFTER_ATTACK_MS = 20 * 60 * 1000;

// 1v1 duels (see /duel and /duelaccept below). pendingDuels is keyed by
// the CHALLENGED player's id — only one incoming challenge at a time
// makes sense for them, and this doubles as the "already has an
// unanswered challenge" guard. activeDuels stores the exact same duel
// object under BOTH participants' ids, so either side's /kick can look
// their own duel up in O(1), and ending it once (see endDuel) removes it
// for both at the same time. Neither map needs to survive a restart —
// same in-memory idiom as every other cooldown/lockout map here.
const pendingDuels = new Map();
const activeDuels = new Map();
const DUEL_CHALLENGE_EXPIRY_MS = 2 * 60 * 1000;
const DUEL_DURATION_MS = 5 * 60 * 1000;

function getDuelOpponentId(duel, userId) {
  return duel.aId === userId ? duel.bId : duel.aId;
}
function getDuelOpponentLabel(duel, userId) {
  return duel.aId === userId ? duel.bLabel : duel.aLabel;
}
// Clears the timeout (whichever one is currently pending — the 5-minute
// timer if this is a death, already fired if this is the timeout itself)
// and removes the duel from both participants at once before paying out
// and announcing the result, so neither side can land one more "in-duel"
// hit on a duel that's technically already over. winnerId is who gets
// the full bank (both stakes); pass null for a draw, which refunds each
// participant their own stake instead. No-op coin-wise whenever
// duel.stake is 0 (no wager was placed).
function endDuel(duel, message, winnerId) {
  clearTimeout(duel.timer);
  activeDuels.delete(duel.aId);
  activeDuels.delete(duel.bId);
  if (duel.stake > 0) {
    if (winnerId) {
      db.prepare('UPDATE pvp_stats SET coins = coins + ? WHERE user_id = ?').run(duel.stake * 2, winnerId);
    } else {
      db.prepare('UPDATE pvp_stats SET coins = coins + ? WHERE user_id = ?').run(duel.stake, duel.aId);
      db.prepare('UPDATE pvp_stats SET coins = coins + ? WHERE user_id = ?').run(duel.stake, duel.bId);
    }
  }
  bot.sendMessage(duel.chatId, message, duel.threadId ? { message_thread_id: duel.threadId } : {}).catch(() => {});
}
function resolveDuelTimeout(duel) {
  const aHealth = getUserHealth(duel.aId).health;
  const bHealth = getUserHealth(duel.bId).health;
  const bankText = duel.stake > 0 ? ` Банк ${duel.stake * 2} монет — победителю.` : '';
  if (aHealth > bHealth) {
    endDuel(duel, `⏱️ Время дуэли вышло! Побеждает ${duel.aLabel} (${aHealth} ХП против ${bHealth}).${bankText}`, duel.aId);
  } else if (bHealth > aHealth) {
    endDuel(duel, `⏱️ Время дуэли вышло! Побеждает ${duel.bLabel} (${bHealth} ХП против ${aHealth}).${bankText}`, duel.bId);
  } else {
    endDuel(duel, `⏱️ Время дуэли вышло! Ничья — у обоих по ${aHealth} ХП.${duel.stake > 0 ? ' Ставки возвращены.' : ''}`, null);
  }
}

// --- Goblin/orc raid (admin-triggered PvE event, see /goblinraid and
// /kick's monster branch below) ---
// Two monster types (see MONSTER_TYPES) attacking once a minute each,
// using the exact same opposed accuracy-vs-dodge PvP roll as human
// /kick — see each type's fixed accuracy/strength/agility/endurance (no
// attribute investment, no /levelup for them). Each one locks onto a
// random eligible warrior (not hidden, not hospitalized, not already at
// 0 HP) at spawn and stays locked on that SAME target forever — it never
// re-rolls on its own, only ever switching because a player actually
// landed a hit on it (see /kick's monster branch), at which point it
// locks onto that attacker instead. If its current target becomes
// temporarily unreachable it just skips that minute's swing rather than
// picking someone else. Energy caps total swings at maxEnergy — once
// spent, it goes harmless but stays alive and lootable for its coins
// until killed. Fighting one is done through /kick itself (by name or
// by replying to one of its messages), not a separate command — same
// interface as fighting a human. In-memory only, same convention as
// activeDuels/pendingDuels — doesn't survive a restart. Despite the
// variable/function names still saying "goblin" throughout (kept as-is
// to avoid a sweeping rename), every one of them now handles both types
// via the `type` field on each monster object.
const MONSTER_TYPES = {
  goblin: {
    names: ['Грызль', 'Шнырь', 'Куцехвост', 'Плюгаш', 'Костолом', 'Гниляк', 'Хрящ', 'Дрызга', 'Мозгоглод', 'Бормотун'],
    maxHealth: 60,
    maxEnergy: 20,
    stats: { accuracy: 3, strength: 1, agility: 5, endurance: 0 },
    weaponText: 'дубинкой',
    emoji: '🟢',
    coinsRange: [3, 10],
  },
  orc: {
    names: ['Груб', 'Кровосек', 'Мясоруб', 'Клык', 'Рёва', 'Черепомёт', 'Дубина', 'Хрипун', 'Секач', 'Ломастер'],
    maxHealth: 120,
    maxEnergy: 35,
    stats: { accuracy: 2, strength: 7, agility: 2, endurance: 3 },
    weaponText: 'дубиной',
    emoji: '🟤',
    coinsRange: [15, 35],
  },
  // Boss-tier, solo-only encounters — see /goblinraid тролль/тролленок
  // below. maxEnergy: Infinity means the energy<=0 skip in goblinTick/
  // trollTick never fires for either (never actually runs out of swings
  // on its own — only the 15-min flee timer, same fleeTimer mechanism
  // the recon uses, ends the fight if nobody kills it). coinsRange
  // [0,0] — starts broke; see resolveMonsterSwing's robbery block, which
  // pays into monster.coins same as goblins/orcs already do, so
  // everything it's robbed off players is what a killer collects.
  // swingTargets/regenIntervalMs/regenPerTick/stealsWeapons are read by
  // trollTick/trollRegenTick/resolveMonsterSwing — every other monster
  // type leaves these undefined, which is fine since only troll-type
  // code paths (see TROLL_TYPES) ever read them.
  troll: {
    names: ['Тролль'],
    maxHealth: 1000,
    maxEnergy: Infinity,
    stats: { accuracy: 4, strength: 15, agility: 1, endurance: 0 },
    weaponText: 'здоровенной дубиной',
    emoji: '🧌',
    coinsRange: [0, 0],
    swingTargets: 3,
    regenIntervalMs: 10 * 1000,
    regenPerTick: 10,
    stealsWeapons: true,
  },
  // Weaker cub version — /goblinraid тролленок. Same accuracy/agility as
  // the adult, everything else scaled down: less strength, less HP,
  // hits 2 targets instead of 3, regenerates much slower.
  troll_young: {
    names: ['Молодой тролль'],
    maxHealth: 650,
    maxEnergy: Infinity,
    stats: { accuracy: 4, strength: 8, agility: 1, endurance: 0 },
    weaponText: 'дубиной',
    emoji: '🧌',
    coinsRange: [0, 0],
    swingTargets: 2,
    regenIntervalMs: 40 * 1000,
    regenPerTick: 5,
    stealsWeapons: true,
  },
};
// endurance has nothing to act on for either type (no energy regen, no
// /levelup) — kept on both stat blocks only for shape parity with a
// player's own getStats().
const GOBLIN_ATTACK_INTERVAL_MS = 60 * 1000;
// Тролль-only tuning (see /goblinraid тролль/тролленок, trollTick,
// trollRegenTick) — shared across both troll variants; whatever differs
// per variant (targets/regen/strength/HP) lives on their own
// MONSTER_TYPES entry instead, read via TROLL_TYPES below.
const TROLL_TYPES = new Set(['troll', 'troll_young']);
const TROLL_ATTACK_INTERVAL_MS = 30 * 1000;
// Granularity trollRegenTick actually runs at — the GCD of every troll
// variant's own regenIntervalMs (10s and 40s), so each variant's regen
// fires exactly on its own schedule via per-monster lastRegenAt
// tracking, not by trying to run several different setInterval cadences
// at once.
const TROLL_REGEN_CHECK_INTERVAL_MS = 5 * 1000;
const TROLL_DURATION_MS = 15 * 60 * 1000;
// Every 4th swing is guaranteed to be a чулан-smash instead of a normal
// hit (roughly once every 2 minutes at the 30s attack cadence) — see
// trollTick. Same for both variants.
const TROLL_CHULAN_BREAK_EVERY_N_ATTACKS = 4;
// Chance, on top of the normal coin-robbery every monster already rolls
// on a knockout, that a stealsWeapons monster specifically also rips
// away one held weapon — see resolveMonsterSwing's stealsWeapons check.
const TROLL_WEAPON_STEAL_CHANCE = 0.5;

// /goblinraid's 4 preset wave compositions — [min, max] goblin/orc counts,
// rolled independently and inclusive on both ends.
const RAID_TIERS = {
  'разведка': { goblins: [2, 5], orcs: [0, 0] },
  'рейд': { goblins: [5, 10], orcs: [0, 0] },
  'атака': { goblins: [5, 10], orcs: [1, 2] },
  'нашествие': { goblins: [10, 20], orcs: [2, 5] },
};
function randIntInclusive(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

let goblinRaid = null; // { goblins: Map<id, monster>, chatId, threadId, tickTimer }
let nextGoblinId = 1;
// messageId -> goblinId, so /kick can resolve its target by replying to
// any message that monster has sent (spawn roster or an attack line)
// instead of typing its name. Cleared whenever the raid ends.
const goblinMessageIds = new Map();

// Same "cached display name off known_users, fall back to a bare id"
// idiom as arenaTick's knife-decay announcement — goblinTick has no real
// Telegram message to pull a label from, unlike every human-vs-human
// combat function in this file.
function labelForUserId(userId) {
  const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(userId);
  return known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${userId}`;
}

function pickEligibleGoblinTarget() {
  const rows = db.prepare('SELECT user_id FROM pvp_stats WHERE is_warrior = 1').all();
  const eligible = rows
    .map((r) => r.user_id)
    .filter((id) => !isHidden(id) && !isInTree(id) && !isHospitalized(id) && !isParalyzed(id) && getUserHealth(id).health > 0);
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

// Тролль's own targeting (see trollTick) — no locked target like
// goblins/orcs, just a fresh batch of up to `count` distinct random
// eligible warriors every swing. Same eligibility filter as
// pickEligibleGoblinTarget above, just returning several via a Fisher-
// Yates shuffle instead of one.
function pickEligibleGoblinTargets(count) {
  const rows = db.prepare('SELECT user_id FROM pvp_stats WHERE is_warrior = 1').all();
  const eligible = rows
    .map((r) => r.user_id)
    .filter((id) => !isHidden(id) && !isInTree(id) && !isHospitalized(id) && !isParalyzed(id) && getUserHealth(id).health > 0);
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  return eligible.slice(0, count);
}

// name index within its own type's pool cycles with a numeric suffix
// once exhausted (11th goblin is the 1st name again + " 2", etc.) — same
// idiom /goblinraid already used before orcs existed, just per-type now.
function monsterName(type, indexWithinType) {
  const names = MONSTER_TYPES[type].names;
  const base = names[indexWithinType % names.length];
  const cycle = Math.floor(indexWithinType / names.length) + 1;
  return cycle > 1 ? `${base} ${cycle}` : base;
}

function spawnMonster(type, indexWithinType) {
  const def = MONSTER_TYPES[type];
  const id = nextGoblinId++;
  return {
    id,
    type,
    name: monsterName(type, indexWithinType),
    health: def.maxHealth,
    maxHealth: def.maxHealth,
    energy: def.maxEnergy,
    coins: randIntInclusive(def.coinsRange[0], def.coinsRange[1]),
    targetUserId: pickEligibleGoblinTarget(),
  };
}

// Ends the raid once every monster is dead: stops the tick (and the
// flee timer, if this raid had one), announces victory, and clears both
// module-level maps so nothing lingers for the next raid. If this was a
// scheduled recon (morning or evening), queues the follow-up raid for 10
// minutes from now with the 'cleared' outcome (see scheduleReconFollowUp
// below).
function checkGoblinRaidCleared() {
  if (!goblinRaid || [...goblinRaid.goblins.values()].some((g) => g.health > 0)) return;
  clearInterval(goblinRaid.tickTimer);
  if (goblinRaid.fleeTimer) clearTimeout(goblinRaid.fleeTimer);
  if (goblinRaid.autoKind === 'morning-recon' || goblinRaid.autoKind === 'evening-recon') {
    scheduleReconFollowUp('cleared', goblinRaid.chatId, goblinRaid.threadId);
  }
  bot.sendMessage(
    goblinRaid.chatId,
    '🏆 Набег отбит — никого не осталось!',
    goblinRaid.threadId ? { message_thread_id: goblinRaid.threadId } : {}
  ).catch(() => {});
  goblinMessageIds.clear();
  goblinRaid = null;
}

// Ends a timed raid (see launchScheduledRaid's durationMs) when its
// clock runs out with monsters still alive — they flee: removed from
// play with no loot, no death message, raid over. If this was a
// scheduled recon (morning or evening), queues the follow-up raid for 10
// minutes from now with the 'fled' outcome — the counterpart to
// checkGoblinRaidCleared's 'cleared' case (see scheduleReconFollowUp
// below).
function endGoblinRaidByFlee() {
  if (!goblinRaid) return;
  const survivors = [...goblinRaid.goblins.values()].filter((g) => g.health > 0);
  clearInterval(goblinRaid.tickTimer);
  const chatId = goblinRaid.chatId;
  const threadId = goblinRaid.threadId;
  const threadOpt = threadId ? { message_thread_id: threadId } : {};
  if (goblinRaid.autoKind === 'morning-recon' || goblinRaid.autoKind === 'evening-recon') {
    scheduleReconFollowUp('fled', chatId, threadId);
  }
  goblinMessageIds.clear();
  goblinRaid = null;
  if (survivors.length > 0) {
    bot.sendMessage(chatId, `🏃 Время вышло — оставшиеся разбегаются: ${survivors.map((g) => g.name).join(', ')}.`, threadOpt).catch(() => {});
  }
}

// Resolves one monster's swing at one specific human target — the shared
// 10%-fuck-instead-of-hit branch, the opposed accuracy-vs-dodge roll
// (exact same shape as performKick's own: nat-100 auto-hit, nat-0
// auto-miss), damage, and on-knockout coin robbery. Extracted out of
// goblinTick so both it (single locked target per monster) and trollTick
// (fresh random targets every swing, no lock) share one implementation.
// monster.type === 'troll' additionally unlocks a weapon-steal chance on
// knockout that goblins/orcs don't get (see TROLL_WEAPON_STEAL_CHANCE) —
// the stolen weapon is just dropped in the raid's chat for anyone but
// the victim to pick up, same as a natural-0 fumble, since the troll
// never actually wields anything but his own club.
async function resolveMonsterSwing(monster, targetUserId) {
  const def = MONSTER_TYPES[monster.type];
  const targetLabel = labelForUserId(targetUserId);
  const chatOpts = goblinRaid.threadId ? { message_thread_id: goblinRaid.threadId } : {};

  // 10% chance this swing is a /fuck attempt instead of a normal hit —
  // same 40%-success/10-40-min-paralysis mechanic as the player command,
  // spending this monster's turn either way instead of rolling the usual
  // accuracy-vs-dodge attack below.
  if (Math.random() < 0.1) {
    let fuckMessage;
    if (Math.random() < FUCK_SUCCESS_CHANCE) {
      const paralysisMinutes = rollFuckParalysisMinutes();
      const until = Math.floor(Date.now() / 1000) + paralysisMinutes * 60;
      db.prepare('UPDATE user_health SET paralyzed_until = ? WHERE user_id = ?').run(until, targetUserId);
      fuckMessage = `😳 ${monster.name} трахает ${targetLabel}! ${targetLabel} получает мощнейший оргазм и парализован(а) на ${paralysisMinutes} мин — не может ни бить, ни быть избитым(ой).`;
    } else {
      fuckMessage = `😅 ${monster.name} пытается трахнуть ${targetLabel}, но ничего не вышло.`;
    }
    const fuckSent = await bot.sendMessage(goblinRaid.chatId, fuckMessage, chatOpts).catch(() => null);
    if (fuckSent) goblinMessageIds.set(fuckSent.message_id, monster.id);
    return;
  }

  const targetInjury = getUserInjury(targetUserId);
  const targetStats = getStats(targetUserId);

  const roll = Math.floor(Math.random() * 101);
  let success;
  let dodged = false;
  let attackerScore = null;
  let defenderScore = null;
  if (roll === 100) {
    success = true;
  } else if (roll === 0) {
    success = false;
  } else {
    attackerScore = roll + def.stats.accuracy * ACCURACY_PER_POINT;
    const dodgeBuffBonus = getHitThreshold(targetUserId) - 50;
    const defendDodgeBonus = isDefending(targetUserId) ? DEFEND_DODGE_BONUS : 0;
    const defenderRoll = Math.floor(Math.random() * 101);
    defenderScore = defenderRoll + dodgeBuffBonus + defendDodgeBonus + targetStats.agility * AGILITY_DODGE_PER_POINT - (targetInjury === 'leg' ? LEG_INJURY_DODGE_PENALTY : 0);
    success = attackerScore > defenderScore;
    dodged = !success;
  }

  const outcome = roll === 0 ? '❌ неудачно' : dodged ? '🌀 уворот!' : '✅ удачно';
  const scoreText = attackerScore !== null ? ` (${Math.round(attackerScore)} против ${Math.round(defenderScore)})` : '';
  const sent = await bot.sendMessage(
    goblinRaid.chatId,
    `${def.emoji} ${monster.name} бьёт ${targetLabel} ${def.weaponText} ${outcome}: ${roll}/100${scoreText}`,
    chatOpts
  ).catch(() => null);
  if (sent) goblinMessageIds.set(sent.message_id, monster.id);
  if (!success) return;

  const defendFactor = isDefending(targetUserId) ? (1 - DEFEND_DAMAGE_REDUCTION) : 1;
  const before = getUserHealth(targetUserId);
  let after;
  if (roll === 100) {
    after = damageHuman(targetUserId, goblinRaid.chatId, null, before.health);
    await bot.sendMessage(
      goblinRaid.chatId,
      `💯 СОКРУШИТЕЛЬНЫЙ УДАР! ${monster.name} сносит ${targetLabel} всё здоровье разом (${before.health} -> ${after})!`,
      chatOpts
    ).catch(() => {});
  } else {
    const strengthFactor = 1 + def.stats.strength * STRENGTH_DAMAGE_PER_POINT;
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const dmg = Math.round(rawDmg * strengthFactor * defendFactor); // club multiplier is 1
    after = damageHuman(targetUserId, goblinRaid.chatId, null, dmg);
    await bot.sendMessage(
      goblinRaid.chatId,
      `💥 Урон ${targetLabel}: ${dmg} (${before.health} -> ${after})`,
      chatOpts
    ).catch(() => {});
  }

  if (after === 0) {
    // Robbery attempt on the kill — 50% chance to even try, and even
    // then only a random cut of whatever coins they're carrying, not
    // a guaranteed clean-out.
    ensureStatsRow(targetUserId);
    const victimCoins = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(targetUserId).coins;
    if (victimCoins > 0 && Math.random() < 0.5) {
      const stolen = 1 + Math.floor(Math.random() * victimCoins);
      db.prepare('UPDATE pvp_stats SET coins = coins - ? WHERE user_id = ?').run(stolen, targetUserId);
      monster.coins += stolen;
      await bot.sendMessage(
        goblinRaid.chatId,
        `🪙 ${monster.name} обчистил ${targetLabel} на ${stolen} монет, пока тот без сознания!`,
        chatOpts
      ).catch(() => {});
    }

    if (def.stealsWeapons) {
      const heldWeapons = getWeaponsFor('human', targetUserId);
      if (heldWeapons.length > 0 && Math.random() < TROLL_WEAPON_STEAL_CHANCE) {
        const stolenRow = heldWeapons[Math.floor(Math.random() * heldWeapons.length)];
        if (stolenRow.instanceKey.startsWith('knife:')) {
          const knifeId = Number(stolenRow.instanceKey.slice('knife:'.length));
          db.prepare('UPDATE owned_knives SET owner_user_id = ?, owner_username = NULL, is_dropped = 1, dropped_chat_id = ? WHERE id = ?').run(targetUserId, goblinRaid.chatId, knifeId);
        } else {
          db.prepare(
            "UPDATE weapon_ownership SET owner_type = 'dropped', owner_user_id = ?, owner_username = NULL, dropped_chat_id = ? WHERE weapon_key = ?"
          ).run(targetUserId, goblinRaid.chatId, stolenRow.weapon_key);
        }
        const stolenDef = WEAPON_DEFS[stolenRow.weapon_key];
        await bot.sendMessage(
          goblinRaid.chatId,
          `${stolenDef.emoji} ${monster.name} вырывает у ${targetLabel} ${stolenDef.accusative} и отшвыривает — своя дубина роднее! Кто первым напишет в чат (кроме ${targetLabel}) — подберёт.`,
          chatOpts
        ).catch(() => {});
      }
    }
  }
}

// One shared 60s tick drives every alive, still-energetic goblin/orc's
// swing — same "one interval, iterate all live entities" idiom as
// healthRegenTick/arenaTick rather than a per-monster timer. Trolls skip
// this entirely (own faster cadence, own targeting — see trollTick);
// the guard below is just defensive in case one ever ended up sharing a
// raid with goblins/orcs, which nothing currently does.
async function goblinTick() {
  if (!goblinRaid || isPvpPaused()) return;
  for (const goblin of goblinRaid.goblins.values()) {
    if (TROLL_TYPES.has(goblin.type)) continue;
    if (goblin.health <= 0 || goblin.energy <= 0) continue;
    if (!goblin.targetUserId) {
      goblin.targetUserId = pickEligibleGoblinTarget();
      if (!goblin.targetUserId) continue;
    }
    if (isHidden(goblin.targetUserId) || isInTree(goblin.targetUserId) || isHospitalized(goblin.targetUserId) || isParalyzed(goblin.targetUserId) || getUserHealth(goblin.targetUserId).health === 0) {
      continue; // waits for its locked target to become reachable again, never re-targets on its own
    }
    goblin.energy -= 1;
    await resolveMonsterSwing(goblin, goblin.targetUserId);
  }
}

// Тролль's own 30s attack cadence (see TROLL_ATTACK_INTERVAL_MS), shared
// by both variants — a solo boss encounter, so this only ever looks for
// one live troll-type monster (see TROLL_TYPES) regardless of which.
// Every 4th swing (TROLL_CHULAN_BREAK_EVERY_N_ATTACKS) is guaranteed to
// be a чулан-smash instead of a normal hit: ends every currently-hidden
// person's /hide session at once, chat-wide (hidden_until isn't scoped
// to a chat, same as /hide itself). Otherwise: this troll's own
// swingTargets fresh random eligible targets (no locked target, unlike
// goblins/orcs), each an independent resolveMonsterSwing call — stops
// early if one of them happens to kill it (someone else's /kick landing
// between swings).
async function trollTick() {
  if (!goblinRaid || isPvpPaused()) return;
  const troll = [...goblinRaid.goblins.values()].find((m) => TROLL_TYPES.has(m.type) && m.health > 0);
  if (!troll) return;
  const def = MONSTER_TYPES[troll.type];

  const chatOpts = goblinRaid.threadId ? { message_thread_id: goblinRaid.threadId } : {};
  troll.attackCount = (troll.attackCount || 0) + 1;
  if (troll.attackCount % TROLL_CHULAN_BREAK_EVERY_N_ATTACKS === 0) {
    const now = Math.floor(Date.now() / 1000);
    const hiddenRows = db.prepare('SELECT user_id FROM user_health WHERE hidden_until IS NOT NULL AND hidden_until * 1000 > ?').all(Date.now());
    if (hiddenRows.length === 0) {
      await bot.sendMessage(goblinRaid.chatId, `${def.emoji} ${troll.name} с рёвом бьёт по чулану — но там никого нет!`, chatOpts).catch(() => {});
      return;
    }
    const names = hiddenRows.map((row) => {
      endHideSession(row.user_id, now);
      return labelForUserId(row.user_id);
    });
    await bot.sendMessage(
      goblinRaid.chatId,
      `${def.emoji} ${troll.name} с рёвом разносит чулан в щепки! Наружу вылетают: ${names.join(', ')}!`,
      chatOpts
    ).catch(() => {});
    return;
  }

  const targets = pickEligibleGoblinTargets(def.swingTargets);
  if (targets.length === 0) return;
  for (const targetUserId of targets) {
    await resolveMonsterSwing(troll, targetUserId);
    if (troll.health <= 0) break;
  }
}

// Тролль's own HP regen — a permanent, always-on tick (same idiom as
// healthRegenTick/bleedTick) rather than a per-raid timer tied to
// goblinRaid's lifecycle: cheap no-op whenever there's no live troll, so
// nothing to leak or forget to clear when a raid ends. Runs at the fine
// TROLL_REGEN_CHECK_INTERVAL_MS granularity but only actually applies a
// tick to a given troll once its OWN regenIntervalMs has elapsed since
// lastRegenAt — lets the two variants regen on genuinely different
// schedules (10s/40s) off one shared interval instead of two.
function trollRegenTick() {
  if (!goblinRaid) return;
  const troll = [...goblinRaid.goblins.values()].find((m) => TROLL_TYPES.has(m.type));
  if (!troll || troll.health <= 0 || troll.health >= troll.maxHealth) return;
  const def = MONSTER_TYPES[troll.type];
  const now = Date.now();
  if (troll.lastRegenAt && now - troll.lastRegenAt < def.regenIntervalMs) return;
  troll.lastRegenAt = now;
  troll.health = Math.min(troll.maxHealth, troll.health + def.regenPerTick);
  bot.sendMessage(
    goblinRaid.chatId,
    `${def.emoji} ${troll.name} восстанавливает силы: +${def.regenPerTick} ХП (${troll.health}/${troll.maxHealth})`,
    goblinRaid.threadId ? { message_thread_id: goblinRaid.threadId } : {}
  ).catch(() => {});
}
setInterval(trollRegenTick, TROLL_REGEN_CHECK_INTERVAL_MS);

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
  // multiplier: 1 is a flat fallback, never used by performKick's own
  // carrot branch (it computes each hole's damage itself) — but
  // performKickGoblin (fighting a goblin/orc) skips carrot's holes
  // entirely and always reads weapon.multiplier directly, so without
  // this fallback that path computed NaN damage, which corrupted the
  // monster's health to NaN permanently (Math.max(0, NaN) is NaN, and
  // every later hit's subtraction from an already-NaN health stays NaN
  // too) — same defensive reason troll-bot's own carrot copy already
  // carries this fallback.
  carrot: { name: 'морковка', instrumental: 'морковкой', accusative: 'морковку', multiplier: 1, emoji: '🥕' },
  // Unlike the 6 weapons above, not a weapon_ownership singleton — see
  // docs/superpowers/specs/2026-08-25-knife-multi-instance-design.md.
  // Each physical knife is its own row in owned_knives, so a player can
  // hold several at once, and multiple players can each hold their own.
  // Acquired via /pick or /shop, each with an independent 3-hour
  // expires_at that arenaTick sweeps ("рассыпается").
  knife: { name: 'ржавый нож', instrumental: 'ржавым ножом', accusative: 'ржавый нож', multiplier: 1.5, emoji: '🔪' },
  // Unique real weapon, seeded to a specific human in troll-bot (shared
  // weapon_ownership, so it can end up here via /kick same as any other
  // real weapon). Its "always hits the head" property is guaranteed-head
  // injury on crit (see the injuryType override in performKick) plus a
  // 20% tooth-knockout on any landed hit (see maybeKnockOutTooth) —
  // stronger here than in troll-bot's own Драка, where injuries don't
  // exist and it's cosmetic-only.
  knuckles: { name: 'кастет', instrumental: 'кастетом', accusative: 'кастет', multiplier: 1.5, emoji: '🥊' },
  // Not seeded to anyone at startup — its first owner is whoever wins the
  // /box code-guessing game (see BOX_CODE handling below); no
  // seed_username row exists for it until then. Holes mechanic mirrors
  // carrot's (see weapon.key === 'dildo' in performKick) and sets its
  // own damage per hole — multiplier: 1 here is the same NaN-guard
  // fallback carrot has just above, for performKickGoblin's benefit.
  dildo: { name: 'оранжевый дилдо', instrumental: 'оранжевым дилдо', accusative: 'оранжевый дилдо', multiplier: 1, emoji: '🍆' },
  // Когти Лимы — flat 1.5x like bat, plus two independent 20%-on-hit
  // procs (see the weapon.key === 'claws' block in performKick): forced
  // /fuck on a random warrior, and a 2-tick delayed poison. Also the only
  // weapon that unlocks a command (/tree) for its current holder.
  claws: { name: 'когти Лимы', instrumental: 'когтями Лимы', accusative: 'когти Лимы', multiplier: 1.5, emoji: '🐾' },
  // Тапки — a physical pair, so its holder swings twice as often as any
  // other weapon (see the weapon.key === 'tapki' cooldown-halving in
  // performKick/performKickGoblin), clean or soiled. multiplier here is
  // the clean baseline (0.7); while isTapkiSoiled() is true (see
  // /piss_tapki), performKick overrides weapon.multiplier to 1 and
  // weapon.text to the ссаные flavor for that swing, and unlocks the
  // 3 independent 20% procs (stun/scare/throw) — none of that lives in
  // this static def since it's time-based, not a fixed property.
  tapki: { name: 'тапки', instrumental: 'тапками', accusative: 'тапки', multiplier: 0.7, emoji: '🥿' },
  // Катана — 3 fully independent swings per /kick instead of one (0.4x/
  // 0.4x/0.8x, see performKatanaSwing + the weapon.key === 'katana'
  // branch in performKick), for the price of a single energy/cooldown
  // spend. multiplier here (0.4) is only a flat single-swing fallback —
  // read by performKickGoblin (fighting goblins/orcs falls back to one
  // normal swing, no combo) and by the NaN-guard precedent every other
  // no-fixed-multiplier weapon above already follows. Also the only
  // weapon with a DEFENSIVE passive: whoever currently holds it has a
  // 25% chance to block any incoming attack outright, /kick or /fuck —
  // see tryKatanaBlock, checked on both the generic swing path and this
  // weapon's own combo.
  katana: { name: 'катана', instrumental: 'катаной', accusative: 'катану', multiplier: 0.4, emoji: '🗡️' },
};

// Claws' own flavor line on a landed hit (see the weapon.key === 'claws'
// block in performKick) — {target} is a plain string replace, same
// idiom as every {user}-style placeholder elsewhere in this file.
const CLAW_HIT_PHRASES = [
  'расцарапала {target} лицо в кровь',
  'прошлась когтями по соскам {target} — те горят огнём',
  'разодрала {target} член когтями',
  'вцепилась когтями {target} в попу — рваные царапины',
  'чиркнула когтями {target} по шее',
  'оставила глубокие кровавые борозды на спине {target}',
];

function getUserInjury(userId) {
  const row = db.prepare('SELECT injury_type, injured_until FROM injuries WHERE user_id = ?').get(userId);
  if (!row) return null;
  if (row.injured_until * 1000 < Date.now()) {
    db.prepare('DELETE FROM injuries WHERE user_id = ?').run(userId);
    return null;
  }
  return row.injury_type;
}

// Recovery time is rolled fresh each time (20-180 min inclusive, i.e. up
// to 3h), not a flat duration — returns the rolled minutes so callers can
// state it in their message.
function applyInjury(userId, injuryType) {
  const healMinutes = Math.floor(Math.random() * 161) + 20;
  const injuredUntil = Math.floor(Date.now() / 1000) + healMinutes * 60;
  db.prepare(
    'INSERT INTO injuries (user_id, injury_type, injured_until) VALUES (?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET injury_type = excluded.injury_type, injured_until = excluded.injured_until'
  ).run(userId, injuryType, injuredUntil);
  return healMinutes;
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

// /tree protection (see WEAPON_DEFS.claws and /tree below) — pure lazy
// read-and-clear, same idiom as isHidden but no session/stats tracking:
// climbing a tree isn't tallied anywhere the way чулан time is.
function isInTree(userId) {
  const row = db.prepare('SELECT tree_until FROM user_health WHERE user_id = ?').get(userId);
  if (!row || !row.tree_until) return false;
  if (row.tree_until * 1000 > Date.now()) return true;
  db.prepare('UPDATE user_health SET tree_until = NULL WHERE user_id = ?').run(userId);
  return false;
}

// Тапки's temporary "ссаные" state (see /piss_tapki below and
// WEAPON_DEFS.tapki) — global to the weapon itself, not per-user (there's
// only ever one pair of tapki), so this reads weapon_ownership directly
// rather than user_health. Pure lazy check, no clearing needed — a stale
// past timestamp just compares false forever, same as every *_until
// column elsewhere that isn't tied to a session needing finalization.
function isTapkiSoiled() {
  const row = db.prepare("SELECT tapki_soiled_until FROM weapon_ownership WHERE weapon_key = 'tapki'").get();
  return !!row && !!row.tapki_soiled_until && row.tapki_soiled_until * 1000 > Date.now();
}

// Ссаные тапки's "scare" proc — is userId currently too scared to swing
// at specifically ofUserId? Lazily clears once expired, same
// check-and-clear idiom as isHidden/isInTree.
function isScaredOf(userId, ofUserId) {
  const row = db.prepare('SELECT scared_of_user_id, scared_until FROM user_health WHERE user_id = ?').get(userId);
  if (!row || !row.scared_of_user_id || !row.scared_until) return false;
  if (row.scared_of_user_id !== ofUserId) return false;
  if (row.scared_until * 1000 > Date.now()) return true;
  db.prepare('UPDATE user_health SET scared_of_user_id = NULL, scared_until = NULL WHERE user_id = ?').run(userId);
  return false;
}

// Катана's passive defense (see WEAPON_DEFS.katana) — whoever currently
// holds it gets a 25% chance to block ANY incoming attack outright,
// regardless of how it would've otherwise resolved (even a nat-100).
// Checked wherever an attack is about to land on defenderId — the
// generic /kick swing path, performKatanaSwing's own combo, and /fuck's
// success branch.
const KATANA_BLOCK_CHANCE = 0.25;
function tryKatanaBlock(defenderId) {
  const holds = getWeaponsFor('human', defenderId).some((w) => w.weapon_key === 'katana');
  if (!holds) return false;
  return Math.random() < KATANA_BLOCK_CHANCE;
}

// Катана's 3-swing combo (see WEAPON_DEFS.katana and the weapon.key ===
// 'katana' branch in performKick, which calls this once per segment).
// Deliberately a near-copy of performKick's own single-swing body — same
// opposed roll, same katana-block check, same crit/injury/XP — just
// parametrized by this swing's own damage multiplier and index (for the
// "N/3" in its message), and trimmed of two things a normal swing has
// that would be awkward to repeat 3x: no nat-0 fumble-drop, and a
// knockout here skips the steal-offer buttons and instant duel-end check
// (still floors health/hospitalizes/mutes via damageHuman as normal —
// just no follow-up UI). Returns the target's resulting health (for the
// caller's "stop early if downed" check), or null if the swing missed,
// was dodged, or was blocked.
async function performKatanaSwing(chatId, msgLike, attacker, target, actorLabel, targetLabel, attackerStats, attackerInjury, segmentMultiplier, swingIndex) {
  const roll = Math.floor(Math.random() * 101);
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
    const dodgeBuffBonus = getHitThreshold(target.id) - 50;
    const defendDodgeBonus = isDefending(target.id) ? DEFEND_DODGE_BONUS : 0;
    const defenderRoll = Math.floor(Math.random() * 101);
    defenderScore = defenderRoll + dodgeBuffBonus + defendDodgeBonus + targetStats.agility * AGILITY_DODGE_PER_POINT - (targetInjury === 'leg' ? LEG_INJURY_DODGE_PENALTY : 0);
    success = attackerScore > defenderScore;
    dodgedByDefender = !success;
  }

  let blockedByKatana = false;
  if (success) {
    blockedByKatana = tryKatanaBlock(target.id);
    if (blockedByKatana) success = false;
  }

  const outcome = blockedByKatana ? '🗡️ заблокировано катаной!' : roll === 0 ? '❌ неудачно' : dodgedByDefender ? '🌀 уворот!' : '✅ удачно';
  const scoreText = attackerScore !== null ? ` (${Math.round(attackerScore)} против ${Math.round(defenderScore)})` : '';
  await bot.sendMessage(
    chatId,
    `${actorLabel} — удар ${swingIndex}/3 катаной по ${targetLabel} ${outcome}: ${roll}/100${scoreText}`,
    threadOpts(msgLike)
  ).catch(() => {});
  if (!success) return null;

  combatLockouts.set(attacker.id, Date.now());

  const strengthFactor = 1 + attackerStats.strength * STRENGTH_DAMAGE_PER_POINT;
  const armInjuryFactor = attackerInjury === 'arm' ? ARM_INJURY_DAMAGE_MULT : 1;
  const defendFactor = isDefending(target.id) ? (1 - DEFEND_DAMAGE_REDUCTION) : 1;

  const targetHealthBefore = getUserHealth(target.id);
  let targetHealthAfter;
  if (roll === 100) {
    targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, targetHealthBefore.health);
    await bot.sendMessage(
      chatId,
      `💯 СОКРУШИТЕЛЬНЫЙ УДАР! ${actorLabel} сносит ${targetLabel} всё здоровье разом (${targetHealthBefore.health} -> ${targetHealthAfter})!`,
      threadOpts(msgLike)
    ).catch(() => {});
  } else {
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const dmg = Math.round(rawDmg * segmentMultiplier * strengthFactor * armInjuryFactor * defendFactor);
    targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(
      chatId,
      `🗡️ Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
      threadOpts(msgLike)
    ).catch(() => {});
  }

  const isCrit = roll >= getCritThreshold(attacker.id);
  if (isCrit) {
    recordCrit(attacker.id);
  }
  const xpGain = roll === 100 ? XP_PER_NAT100 : isCrit ? XP_PER_CRIT : XP_PER_HIT;
  ensureStatsRow(attacker.id);
  db.prepare('UPDATE pvp_stats SET xp = xp + ? WHERE user_id = ?').run(xpGain, attacker.id);
  if (roll !== 100 && isCrit) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healMinutes = applyInjury(target.id, injuryType);
    recordInjuryDealt(attacker.id);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      chatId,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healMinutes} мин).`,
      threadOpts(msgLike)
    ).catch(() => {});
  }

  if (targetHealthAfter === 0) {
    if (isHospitalized(target.id)) {
      await bot.sendMessage(
        chatId,
        `🏥 ${targetLabel} без сознания и попадает в больничку (−1 монета из кошелька) — недоступен для удара, пока не наберёт ${HOSPITAL_EXIT_HEALTH} ХП (или сам не решит атаковать раньше, если наберётся хотя бы ${HOSPITAL_MIN_DISCHARGE_HEALTH} ХП).`,
        threadOpts(msgLike)
      ).catch(() => {});
    } else {
      await bot.sendMessage(
        chatId,
        `😵 ${targetLabel} без сознания, но денег на больничку нет — остаётся на улице, замьючен(а) на 30 мин (не может атаковать).`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
  }

  return targetHealthAfter;
}

const KATANA_SEGMENT_MULTIPLIERS = [0.4, 0.4, 0.8];

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

// Whether an attacker is still within their post-knockout mute (see
// damageHuman's muteUser(..., 'драка', 30 min) call below — only
// reached when больничка couldn't be paid for, see
// docs/superpowers/specs/2026-08-25-paid-hospital-design.md). /kick
// used to gate on health === 0 directly, but healthRegenTick's hourly
// trickle can bring health back above 0 within as little as 10 minutes
// — well before the intended 30-minute "в отключке" window ends —
// which let a just-regenerated attacker swing again with no warning.
// Checking the mute row (by reason, not by admin mutes in general) is
// the actual source of truth for "still down from a fight" regardless
// of how far health has already regenerated.
function isKnockedOut(userId) {
  const row = db.prepare('SELECT muted_by_name, expires_at FROM mutes WHERE user_id = ?').get(userId);
  if (!row || row.muted_by_name !== 'драка') return false;
  if (row.expires_at && row.expires_at * 1000 < Date.now()) {
    db.prepare('DELETE FROM mutes WHERE user_id = ?').run(userId);
    return false;
  }
  return true;
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
  if (row.health === 0 && !isHospitalized(userId) && !isKnockedOut(userId)) {
    // Больничка costs 1 coin to enter — can't pay, don't get admitted.
    // No coins means the guarded UPDATE below matches 0 rows (paid is
    // falsy), same as a missing pvp_stats row entirely (shouldn't
    // happen in practice — reaching 0 HP always implies a warrior, who
    // always has a row — but handled safely regardless).
    // The isHospitalized/isKnockedOut guard above matters because
    // damageHuman isn't always the only hit landing on someone in a
    // single /kick swing — e.g. axe's 20% bonus damage calls this a
    // second time right after the main hit, on a target already
    // floored to 0. Without this guard, that second call would charge
    // a second coin (or, worse, mute an already-hospitalized player
    // via the no-coins fallback) for the same knockout.
    const paid = db.prepare('UPDATE pvp_stats SET coins = coins - 1 WHERE user_id = ? AND coins >= 1 RETURNING coins').get(userId);
    if (paid) {
      db.prepare('UPDATE user_health SET hospitalized_since = ? WHERE user_id = ?').run(now, userId);
    } else {
      muteUser(userId, chatId, username, 0, 'драка', 30 * 60 * 1000);
    }
  }
  return row.health;
}

// Кастет-only special effect (see WEAPON_DEFS.knuckles) — 20% chance per
// landed hit to knock out a tooth, costing the victim 1 energy. Unlike
// troll-bot's identical copy, no owner-type branch is needed here: /kick
// is human-vs-human only, so the victim is always a human.
function maybeKnockOutTooth(victimUserId) {
  if (Math.random() >= 0.2) return false;
  db.prepare('UPDATE user_health SET energy = MAX(0, energy - 1) WHERE user_id = ?').run(victimUserId);
  return true;
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
// "Поединки" is a forum TOPIC inside ARENA_CHAT_ID, not a separate chat —
// confirmed via /chatid run inside it. Regular command replies stay in
// the right topic automatically via threadOpts(msg) (msg carries its own
// message_thread_id), but background jobs (arenaTick/bleedTick/
// healthRegenTick's daily payout) have no triggering message to read a
// thread id from, so without this they default to the group's General
// topic — which is "Таверна" — instead of "Поединки". Every background
// announcement below must pass { message_thread_id: ARENA_TOPIC_ID }
// explicitly.
const ARENA_TOPIC_ID = 175758;
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

// Weapons currently held by a given owner. A holder can end up with
// several of the 6 singleton weapons over time via the knockout
// weapon-steal offer, plus any number of knives (each an independent
// owned_knives row — see instanceKey below). ownerUserId is
// ignored for ownerType 'troll' (there's only ever one troll). ORDER BY
// rowid gives a stable "acquisition order" (rowid is assigned once, at
// each weapon's original seed INSERT, and never changes across the
// UPDATEs that move ownership around) — this is what /kick1/2/3 index
// into, and what /me numbers its weapon list by.
function getWeaponsFor(ownerType, ownerUserId) {
  // Returns { weapon_key, instanceKey } rows. instanceKey === weapon_key
  // for every singleton weapon (bat/axe/scissors/crutch/horns/carrot —
  // weapon_key is still a PK for these, unchanged behavior) — it only
  // ever differs for a knife, where it's "knife:<owned_knives.id>" so a
  // SPECIFIC physical knife can be identified among several this same
  // owner might hold. Regular weapons first (stable rowid order, as
  // before), knives appended after in acquisition order. Knife rows also
  // carry an expiresAt field (unix seconds) that regular-weapon rows
  // don't — used by /me to show remaining decay time.
  if (ownerType === 'troll') {
    return db.prepare("SELECT weapon_key, weapon_key AS instanceKey FROM weapon_ownership WHERE owner_type = 'troll' ORDER BY rowid").all();
  }
  const regular = db.prepare(
    "SELECT weapon_key, weapon_key AS instanceKey FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now')) ORDER BY rowid"
  ).all(ownerUserId);
  const knives = db.prepare(
    "SELECT id, expires_at FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now') ORDER BY id"
  ).all(ownerUserId).map(row => ({ weapon_key: 'knife', instanceKey: `knife:${row.id}`, expiresAt: row.expires_at }));
  return [...regular, ...knives];
}

// Picks the weapon for one swing at a specific "slot": slot 0 always
// means bare-handed (a random cosmetic word from fallbackWeapons,
// multiplier 1) even if the attacker holds real weapons — /kick with no
// number. slot 1/2/3 means the Nth real weapon the attacker currently
// holds, in getWeaponsFor's stable acquisition order — /kick1/2/3. Falls
// back to bare-handed if they don't hold that many. Returns
// { key, instanceKey, text, multiplier } — key/instanceKey are null for
// the cosmetic fallback.
function pickWeaponForAttacker(ownerType, ownerUserId, slot, fallbackWeapons) {
  if (slot > 0) {
    const owned = getWeaponsFor(ownerType, ownerUserId);
    const row = owned[slot - 1];
    if (row) {
      const def = WEAPON_DEFS[row.weapon_key];
      return { key: row.weapon_key, instanceKey: row.instanceKey, text: def.instrumental, multiplier: def.multiplier };
    }
  }
  return { key: null, instanceKey: null, text: pick(fallbackWeapons), multiplier: 1 };
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

// /box guessing game (see below) — 1 attempt/hour/player, separate from
// every other cooldown map for the same reason hideCooldowns is its own.
const boxCooldowns = new Map();
const BOX_COOLDOWN_MS = 60 * 60 * 1000;

// Lazily generates and persists the 3-digit /box secret the first time
// it's needed, so restarts don't reroll it — it's meant to stand
// indefinitely until someone actually guesses it (see the /box command
// below). Stored as a zero-padded string in bot_settings so a code like
// 7 round-trips as "007", not "7".
function getBoxCode() {
  const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'box_code'").get();
  if (row) return row.value;
  const code = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('box_code', ?)").run(code);
  return code;
}

const BOX_POSITION_NAMES = ['первая', 'вторая', 'третья'];

// Which of the 3 digits is "jammed" (permanently visible) — rolled once
// and persisted the same way as the code itself, so it's the same digit
// every time someone checks, not a fresh random one per attempt.
function getBoxRevealedPosition() {
  const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'box_revealed_position'").get();
  if (row) return parseInt(row.value, 10);
  const position = Math.floor(Math.random() * 3);
  db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('box_revealed_position', ?)").run(String(position));
  return position;
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
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
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
    if (row.weapon_key === 'knife') {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: урон ×${def.multiplier} (осталось ${formatExpire(row.expiresAt)})`);
    } else if (row.weapon_key === 'carrot') {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: случайное место попадания, от лечения до мгновенного нокаута`);
    } else if (row.weapon_key === 'katana') {
      lines.push(`${def.emoji} ${slotTag} — ${def.name}: 3 независимых удара за один /kick (0.4x/0.4x/0.8x); 25% блок любой атаки по тебе, включая /fuck`);
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

  if (isInTree(msg.from.id)) {
    const treeRow = db.prepare('SELECT tree_until FROM user_health WHERE user_id = ?').get(msg.from.id);
    lines.push(`🌳 Сидишь на дереве (осталось ${formatExpire(treeRow.tree_until)})`);
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

  // Level is levelInfoForXp's own level count — the same number that
  // already drives available points (available + already-spent points
  // always sums back to this), just surfaced directly instead of making
  // people do the math themselves. No cap: keeps climbing as long as xp
  // does (see levelInfoForXp for the flat-100-then-×1.1-from-level-10
  // cost curve).
  const { level, nextThreshold } = levelInfoForXp(stats.xp);
  const available = level - (stats.accuracy + stats.strength + stats.agility + stats.endurance);
  const xpToNext = nextThreshold - stats.xp;
  lines.push(`🏆 Уровень: ${level}`);
  lines.push(`📊 Точность: ${stats.accuracy} | Сила: ${stats.strength} | Ловкость: ${stats.agility} | Выносливость: ${stats.endurance}`);
  lines.push(`✨ Опыт: ${stats.xp} (ещё ${xpToNext} до следующего очка)${available > 0 ? ` — доступно очков: ${available}` : ''}`);

  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});

bot.onText(/\/hide(?:\s+(\d+))?\b/, (msg, match) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
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

// /tree (see WEAPON_DEFS.claws) — exclusive to whoever currently holds
// когти Лимы. Much cheaper/shorter than /hide (1 energy flat, 5 min
// flat, no чулан-style capacity limit, no self-cooldown) since it's a
// weapon perk, not a general-purpose PvP tool — energy itself is the
// only throttle.
const TREE_ENERGY_COST = 1;
const TREE_DURATION_MS = 5 * 60 * 1000;
bot.onText(/\/tree\b/, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const ownsClaws = getWeaponsFor('human', msg.from.id).some((w) => w.weapon_key === 'claws');
  if (!ownsClaws) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, лезть на дерево может только владелец когтей Лимы.`, threadOpts(msg)).catch(() => {});
    return;
  }
  getUserHealth(msg.from.id);
  const energyRow = db.prepare(
    'UPDATE user_health SET energy = energy - ? WHERE user_id = ? AND energy >= ? RETURNING energy'
  ).get(TREE_ENERGY_COST, msg.from.id, TREE_ENERGY_COST);
  if (!energyRow) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии залезть на дерево.`, threadOpts(msg)).catch(() => {});
    return;
  }
  const treeUntil = Math.floor((Date.now() + TREE_DURATION_MS) / 1000);
  db.prepare('UPDATE user_health SET tree_until = ? WHERE user_id = ?').run(treeUntil, msg.from.id);
  bot.sendMessage(msg.chat.id, `🌳🐾 ${actorLabel} вонзается когтями в кору и взбирается на дерево — прячется там 5 минут.`, threadOpts(msg)).catch(() => {});
});

// /piss_tapki (see WEAPON_DEFS.tapki/isTapkiSoiled) — exclusive to
// whoever currently holds тапки. Temporary, not a one-way upgrade: 10
// minutes of ссаные тапки (1x multiplier + the 3 procs, see
// performKick's weapon.key === 'tapki' block), then it reverts to plain
// тапки (0.7x, no procs) on its own. 1 energy, own 20-min cooldown
// (separate from hideCooldowns/pvpCooldowns — gates re-triggering this
// specific command, not attacking).
const PISS_TAPKI_ENERGY_COST = 1;
const PISS_TAPKI_COOLDOWN_MS = 20 * 60 * 1000;
const PISS_TAPKI_DURATION_MS = 10 * 60 * 1000;
const pissTapkiCooldowns = new Map();
bot.onText(/\/piss_tapki\b/, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const ownsTapki = getWeaponsFor('human', msg.from.id).some((w) => w.weapon_key === 'tapki');
  if (!ownsTapki) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, поссать на тапки может только их владелец.`, threadOpts(msg)).catch(() => {});
    return;
  }
  const last = pissTapkiCooldowns.get(msg.from.id);
  const elapsed = last ? Date.now() - last : Infinity;
  if (elapsed < PISS_TAPKI_COOLDOWN_MS) {
    const remaining = Math.ceil((PISS_TAPKI_COOLDOWN_MS - elapsed) / 60000);
    bot.sendMessage(msg.chat.id, `${actorLabel}, можно поссать на тапки не чаще раза в 20 минут — подожди ещё ${remaining} мин.`, threadOpts(msg)).catch(() => {});
    return;
  }
  getUserHealth(msg.from.id);
  const energyRow = db.prepare(
    'UPDATE user_health SET energy = energy - ? WHERE user_id = ? AND energy >= ? RETURNING energy'
  ).get(PISS_TAPKI_ENERGY_COST, msg.from.id, PISS_TAPKI_ENERGY_COST);
  if (!energyRow) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии.`, threadOpts(msg)).catch(() => {});
    return;
  }
  pissTapkiCooldowns.set(msg.from.id, Date.now());
  const soiledUntil = Math.floor((Date.now() + PISS_TAPKI_DURATION_MS) / 1000);
  db.prepare("UPDATE weapon_ownership SET tapki_soiled_until = ? WHERE weapon_key = 'tapki'").run(soiledUntil);
  bot.sendMessage(msg.chat.id, `🥿💦 ${actorLabel} писает на тапки — теперь это ссаные тапки на 10 минут!`, threadOpts(msg)).catch(() => {});
});

// /find — lists every fighter that has ever appeared in user_health (has
// hit /kick or /hide at least once), by known_users' cached display
// name, with their current hidden status — чулан occupants listed first.
bot.onText(/\/find\b/, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  // Only warriors — user_health also picks up non-warrior/troll-bot
  // activity (that table is shared cross-process), which isn't a
  // meaningful "where is this fighter" answer for /kick's own roster.
  const fighters = db.prepare('SELECT user_id FROM pvp_stats WHERE is_warrior = 1').all();
  if (!fighters.length) {
    bot.sendMessage(msg.chat.id, 'Пока никто не дрался и не прятался.', threadOpts(msg)).catch(() => {});
    return;
  }
  // Icons instead of spelled-out status, sorted чулан-occupants first —
  // isHidden also lazily finalizes anyone whose session has actually
  // expired into pvp_stats before it's used for sorting/display.
  const hospitalLines = [];
  const hiddenLines = [];
  const treeLines = [];
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
    } else if (isInTree(user_id)) {
      const row = db.prepare('SELECT tree_until FROM user_health WHERE user_id = ?').get(user_id);
      treeLines.push(`🌳 ${label} (ещё ${formatExpire(row.tree_until)})`);
    } else {
      visibleLines.push(`⚔️ ${label}`);
    }
  }
  const lines = ['Бойцы:', ...hospitalLines, ...hiddenLines, ...treeLines, ...visibleLines];
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

// Per-level XP cost: flat 100 for levels 1-9, then ×1.1 compounding from
// level 10 onward (level 10 costs 110, 11 costs 121, 12 costs 133, ...),
// each rounded to a whole number so thresholds stay clean integers
// instead of e.g. 133.10000000000002. Walks forward from level 0 rather
// than inverting the compounding formula (solving for the exact level
// via logarithms) — the forward walk is exact and immune to the
// floating-point edge cases an inverse log/pow computation would risk
// right at a threshold boundary, and is plenty fast since no player is
// ever going to reach a level count where a simple loop matters.
// Returns { level, nextThreshold }: level is how many points the given
// xp total has fully paid for (same meaning the old flat floor(xp/100)
// had), nextThreshold is the cumulative xp needed to reach level+1 (so
// "xp needed" is simply nextThreshold - xp).
function levelInfoForXp(xp) {
  let level = 0;
  let cumulative = 0;
  let nextCost = 100;
  while (true) {
    const nextLevel = level + 1;
    nextCost = Math.round(nextLevel <= 9 ? 100 : 100 * Math.pow(1.1, nextLevel - 9));
    if (cumulative + nextCost > xp) break;
    cumulative += nextCost;
    level = nextLevel;
  }
  return { level, nextThreshold: cumulative + nextCost };
}

// Shared by /levelup's own text-argument path and its inline-button
// click handler (see the callback_query branch further below) — spends
// exactly one point on statColumn for userId, also bumping max_energy
// directly for endurance and max_health for strength (see the
// ALTER/UPDATE idiom used everywhere else in this file for those
// columns). Neither bump also tops up the current value — same
// "raising the ceiling doesn't refill you" precedent endurance's
// max_energy bump already set. Returns the new value.
function spendLevelupPoint(userId, statColumn) {
  db.prepare(`UPDATE pvp_stats SET ${statColumn} = ${statColumn} + 1 WHERE user_id = ?`).run(userId);
  if (statColumn === 'endurance') {
    db.prepare('UPDATE user_health SET max_energy = max_energy + 1 WHERE user_id = ?').run(userId);
  }
  if (statColumn === 'strength') {
    db.prepare('UPDATE user_health SET max_health = max_health + 5 WHERE user_id = ?').run(userId);
  }
  return db.prepare(`SELECT ${statColumn} FROM pvp_stats WHERE user_id = ?`).get(userId)[statColumn];
}

// One-off backfill for strength -> max_health: everyone who already had
// points in strength before this feature existed gets their max_health
// raised retroactively (+5 per point), same as if they'd spent each
// point after the feature shipped. Current health is deliberately left
// alone — same "raises the ceiling, doesn't top you up" rule
// spendLevelupPoint itself follows.
runOnce('2026-08-28-strength-max-health-backfill', () => {
  db.exec(`
    UPDATE user_health
    SET max_health = max_health + 5 * (SELECT strength FROM pvp_stats WHERE pvp_stats.user_id = user_health.user_id)
    WHERE user_id IN (SELECT user_id FROM pvp_stats WHERE strength > 0)
  `);
});

function levelupKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Точность', callback_data: 'levelup:accuracy' }, { text: 'Сила', callback_data: 'levelup:strength' }],
      [{ text: 'Ловкость', callback_data: 'levelup:agility' }, { text: 'Выносливость', callback_data: 'levelup:endurance' }],
    ],
  };
}

bot.onText(/\/levelup(?:\s+(\S+))?/i, (msg, match) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const arg = match[1] ? match[1].toLowerCase() : null;
  const stats = getStats(msg.from.id);
  const { level, nextThreshold } = levelInfoForXp(stats.xp);
  const available = level - (stats.accuracy + stats.strength + stats.agility + stats.endurance);

  // No argument — offer buttons instead of making them type a name.
  if (!arg) {
    if (available <= 0) {
      const needed = nextThreshold - stats.xp;
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
    const needed = nextThreshold - stats.xp;
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

// One-time: everyone who was already a warrior before this deploy gets
// the same +20 coins new registrations now grant via /warrior below.
// Placed here (not with the other runOnce migrations near the top of
// the file) specifically because it references ARENA_CHAT_ID, which
// isn't declared yet at that earlier point in the script — runOnce
// calls its callback synchronously, immediately, so this would throw a
// temporal-dead-zone ReferenceError if moved up there.
runOnce('2026-08-25-warrior-wallets', () => {
  db.exec('UPDATE pvp_stats SET coins = coins + 20 WHERE is_warrior = 1');
  // The coins grant above is a reliable local DB write; this announcement
  // is a fire-and-forget network call at process boot, when the bot may
  // not yet be fully up in that chat — runOnce's one-time-ever semantics
  // mean a lost announcement can never self-heal on a later restart, so
  // at least log a failure instead of swallowing it silently.
  bot.sendMessage(
    ARENA_CHAT_ID,
    '🪙 Всем воинам открыли кошельки — на счету у каждого сразу +20 монет! Баланс — /wallet.'
  ).catch(err => console.error('warrior-wallets announcement failed:', err.message));
});

// /pvpon, /pvpoff — admin-only global kill switch for the entire PvP
// subsystem (see docs/superpowers/specs/2026-08-25-pvp-pause-design.md).
// Not named /start or /stop: /start already exists (see near the top of
// this file) as the standard bot-greeting command, matched by an
// unanchored regex that would also catch "/startpvp" as a substring.
bot.onText(/\/pvpoff\b/i, async (msg) => {
  if (!await isAdmin(msg)) return;
  db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('pvp_paused', '1')").run();
  bot.sendMessage(msg.chat.id, '⛔ PvP-бои приостановлены.', threadOpts(msg)).catch(() => {});
});

bot.onText(/\/pvpon\b/i, async (msg) => {
  if (!await isAdmin(msg)) return;
  db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('pvp_paused', '0')").run();
  bot.sendMessage(msg.chat.id, '✅ PvP-бои снова разрешены.', threadOpts(msg)).catch(() => {});
});

// /warrior — the only way to become eligible for /kick (see the
// isWarrior gate in performKick below), one-time per person. Grants
// 300 XP (3 points under the existing floor(xp/100) formula) rather
// than any new interactive UI — the person then spends them the same
// way as any other banked points, via /levelup, same as everyone else.
bot.onText(/\/warrior\b/i, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  if (isWarrior(msg.from.id)) {
    bot.sendMessage(msg.chat.id, `${actorLabel}, ты уже воин.`, threadOpts(msg)).catch(() => {});
    return;
  }
  ensureStatsRow(msg.from.id);
  db.prepare('UPDATE pvp_stats SET is_warrior = 1, xp = xp + 300, coins = coins + 20 WHERE user_id = ?').run(msg.from.id);
  bot.sendMessage(
    msg.chat.id,
    `⚔️ ${actorLabel} теперь воин! Начислено 300 опыта (3 очка) — вложи их: /levelup точность|сила|ловкость|выносливость (можно все 3 раза в одну характеристику или по-разному). Также +20 монет в кошелёк — баланс: /wallet.`,
    threadOpts(msg)
  ).catch(() => {});
});

// /wallet — self-only balance check, deliberately not part of /me (see
// spec). A null row (someone who's never touched pvp_stats) just reads
// as 0 — nothing is written here, so no ensureStatsRow call is needed.
bot.onText(/\/wallet\b/i, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const row = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(msg.from.id);
  const coins = row ? row.coins : 0;
  bot.sendMessage(msg.chat.id, `🪙 ${actorLabel}, у тебя в кошельке: ${coins} монет.`, threadOpts(msg)).catch(() => {});
});

// Rank-position prefix for /warriors — only the top 10 get a numbered
// emoji, everyone below that gets no prefix at all (see /warriors below).
const WARRIOR_RANK_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// /warriors — roster of everyone who's registered via /warrior, sorted by
// xp (highest first — the same value level is derived from). Each line:
// rank emoji (top 10 only), display name, level in parens, health as
// plain text (not an icon, distinct from the crit/damage messages
// elsewhere), held real weapon(s) by emoji (blank if none).
bot.onText(/\/warriors\b/i, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const warriors = db.prepare('SELECT user_id FROM pvp_stats WHERE is_warrior = 1 ORDER BY xp DESC').all();
  if (!warriors.length) {
    bot.sendMessage(msg.chat.id, 'Пока нет ни одного воина — используй /warrior, чтобы стать первым.', threadOpts(msg)).catch(() => {});
    return;
  }
  const lines = ['⚔️ Воины:'];
  warriors.forEach(({ user_id }, index) => {
    const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(user_id);
    const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${user_id}`;
    const health = getUserHealth(user_id);
    const stats = getStats(user_id);
    const level = levelInfoForXp(stats.xp).level;
    const heldWeapons = getWeaponsFor('human', user_id);
    const weaponIcons = heldWeapons.map(row => WEAPON_DEFS[row.weapon_key].emoji).join('');
    const rankPrefix = index < 10 ? `${WARRIOR_RANK_EMOJIS[index]} ` : '';
    lines.push(`${rankPrefix}${label}(${level}) — хп: ${health.health}/${health.max_health}${weaponIcons ? ' ' + weaponIcons : ''}`);
  });
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});

// /pick — claims one crate from the current arena drop (see arenaTick
// above). Random pick among whatever's still unclaimed in this batch,
// atomic claim (guards a same-instant double-click, though Node's
// single-threaded/synchronous execution already makes that essentially
// impossible here), one crate per player per batch.
bot.onText(/\/pick\b/i, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
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
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 3 * 3600;
    db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)').run(msg.from.id, msg.from.username, now, expiresAt);
    bot.sendMessage(msg.chat.id, `📦🔪 ${actorLabel} открыл ящик и нашёл ржавый нож! Урон ×1.5, рассыплется через 3 часа.`, threadOpts(msg)).catch(() => {});
  }
});

// /box <код> — separate from /pick's crates above: one single locked box
// with a secret 3-digit code, standing indefinitely until someone guesses
// it. What's inside stays unrevealed until then (see the design that
// motivated this — deliberately not telling players it's the orange
// dildo up front). 1 guess/hour/player (boxCooldowns). Once claimed, the
// prize is seeded into weapon_ownership and behaves like any other real
// weapon from then on (stealable, droppable on a nat-0 fumble, etc.) —
// the presence of that row is itself the "already claimed" flag, so no
// separate claimed marker is needed.
bot.onText(/\/box\s+(\d{1,3})\b/, async (msg, match) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  if (db.prepare("SELECT 1 FROM weapon_ownership WHERE weapon_key = 'dildo'").get()) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, ящик уже открыт — приз давно забрали.`, threadOpts(msg)).catch(() => {});
  }

  const now = Date.now();
  const last = boxCooldowns.get(msg.from.id);
  if (last && now - last < BOX_COOLDOWN_MS) {
    const minutesLeft = Math.ceil((BOX_COOLDOWN_MS - (now - last)) / 60000);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, следующая попытка через ${minutesLeft} мин.`, threadOpts(msg)).catch(() => {});
  }
  boxCooldowns.set(msg.from.id, now);

  const guess = match[1].padStart(3, '0');
  const code = getBoxCode();
  if (guess !== code) {
    const position = getBoxRevealedPosition();
    const digit = code[position];
    return bot.sendMessage(
      msg.chat.id,
      `${actorLabel}, неверно. Подсказка: заклинила ${BOX_POSITION_NAMES[position]} цифра — она = ${digit}.`,
      threadOpts(msg)
    ).catch(() => {});
  }

  // Atomic claim: guards the (rare but possible) race of two correct
  // guesses landing before either response is sent — same "compare and
  // swap via WHERE" idiom as /pick's own crate claim above.
  const claimed = db.prepare(
    "INSERT INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) " +
    "SELECT 'dildo', NULL, 'human', ?, ? WHERE NOT EXISTS (SELECT 1 FROM weapon_ownership WHERE weapon_key = 'dildo')"
  ).run(msg.from.id, msg.from.username || null);
  if (claimed.changes === 0) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, опоздал — приз только что забрали.`, threadOpts(msg)).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `📦🍆 ${actorLabel} угадал код и достаёт из ящика оранжевое дилдо!`, threadOpts(msg)).catch(() => {});
});

// One-time "the box falls" announcement for /box above — fires once, 5
// minutes after the first boot following this deploy, never again after
// that (even across later restarts), same runOnce idiom as the migrations
// further up. Contents stay unrevealed in the message itself, matching
// the design that keeps them a secret until someone actually wins.
// Skips silently if the box is somehow already claimed by the time the
// timer fires (e.g. a very fast manual DB edit) — not expected in
// practice, just cheap insurance.
runOnce('2026-08-27-box-drop-announcement', () => {
  setTimeout(() => {
    if (db.prepare("SELECT 1 FROM weapon_ownership WHERE weapon_key = 'dildo'").get()) return;
    bot.sendMessage(
      ARENA_CHAT_ID,
      '📦❓ С неба упал загадочный запертый ящик с трёхзначным кодом... Что внутри — тайна. Угадай код: /box <код> (1 попытка в час на игрока).',
      { message_thread_id: ARENA_TOPIC_ID }
    ).catch(() => {});
  }, 5 * 60 * 1000);
});

// /inventory — shows the current elixir stockpile (see /pick above).
bot.onText(/\/inventory\b/i, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
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
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  if (activeDuels.has(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, эликсиры нельзя использовать во время дуэли.`, threadOpts(msg)).catch(() => {});
  }
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
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  if (activeDuels.has(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, эликсиры нельзя использовать во время дуэли.`, threadOpts(msg)).catch(() => {});
  }
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

// /shop — see docs/superpowers/specs/2026-08-25-shop-elixirs-design.md.
// No warrior gate, matching /restore/recharge/inventory — a non-warrior
// can't buy anything anyway since they can only ever have 0 coins.
function shopCategoryKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧪 Эликсиры', callback_data: 'shop:elixirs' }],
      [{ text: '🗡 Оружие', callback_data: 'shop:weapons' }],
      [{ text: '👕 Одежда (скоро)', callback_data: 'shop:soon' }],
    ],
  };
}
function elixirShopText(actorLabel, stats) {
  return `🧪 ${actorLabel}, магазин эликсиров. Баланс: ${stats.coins} монет. У тебя: ❤️×${stats.health_elixirs}, ⚡×${stats.energy_elixirs}.\n` +
    `Купить эликсир здоровья — 5 монет | Купить эликсир энергии — 5 монет\n` +
    `Продать эликсир здоровья — 3 монеты | Продать эликсир энергии — 3 монеты`;
}
function elixirShopKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧪❤️ Купить (5)', callback_data: 'shop:buy:health' }, { text: '🧪⚡ Купить (5)', callback_data: 'shop:buy:energy' }],
      [{ text: '🧪❤️ Продать (3)', callback_data: 'shop:sell:health' }, { text: '🧪⚡ Продать (3)', callback_data: 'shop:sell:energy' }],
      [{ text: '⬅️ Назад', callback_data: 'shop:back' }],
    ],
  };
}
function weaponShopText(actorLabel, coins, knifeCount) {
  return `🗡 ${actorLabel}, магазин оружия. Баланс: ${coins} монет. У тебя ножей: ${knifeCount}.\n` +
    `Купить ржавый нож — 5 монет\n` +
    `Продать ржавый нож — 3 монеты`;
}
function weaponShopKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔪 Купить (5)', callback_data: 'shop:buy:knife' }, { text: '🔪 Продать (3)', callback_data: 'shop:sell:knife' }],
      [{ text: '⬅️ Назад', callback_data: 'shop:back' }],
    ],
  };
}
bot.onText(/\/shop\b/i, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  bot.sendMessage(
    msg.chat.id,
    `🏪 ${actorLabel}, магазин:`,
    threadOpts(msg, { reply_markup: shopCategoryKeyboard() })
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
  // itemType is "weapon:<instanceKey>" — for a knife that's
  // "weapon:knife:17", so WEAPON_DEFS needs just the "knife" part, not
  // the full instanceKey (which isn't a valid WEAPON_DEFS key itself).
  const instanceKey = itemType.slice('weapon:'.length);
  const weaponKey = instanceKey.startsWith('knife:') ? 'knife' : instanceKey;
  const def = WEAPON_DEFS[weaponKey];
  return `${def.emoji} ${def.accusative}`;
}

// Target resolution copied from /kick rather than shared — this file
// duplicates these small per-command snippets instead of extracting a
// helper.
bot.onText(/\/give\b(?:@\w+)?(?:\s+@?(\S+))?/, async (msg, match) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  let target = null;
  // Forum topics ("Поединки" included) implement threading via reply
  // chains under the hood — Telegram auto-sets reply_to_message to the
  // topic's own opening message (message_id === message_thread_id) on
  // every plain message posted in the topic, even when nobody tapped
  // "Reply". Without this check, that phantom reply silently overrode
  // the actual @username argument and always resolved to whoever
  // originally opened the topic.
  const isPhantomTopicReply = msg.reply_to_message && msg.message_thread_id && msg.reply_to_message.message_id === msg.message_thread_id;
  if (msg.reply_to_message && msg.reply_to_message.from && !isPhantomTopicReply) {
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
  for (const { weapon_key, instanceKey } of weapons) {
    const def = WEAPON_DEFS[weapon_key];
    buttons.push([{ text: `${def.emoji} ${def.name}`, callback_data: `gv_i:${msg.from.id}:${target.id}:weapon:${instanceKey}` }]);
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
  // Duel exclusivity (see /duel below): full mutual lock — a duelist can
  // only hit their own opponent, and nobody outside the duel can hit
  // either of them. Two independent checks since either side of the
  // pairing (attacker locked into some duel, or target locked into some
  // duel) is enough to refuse the swing on its own.
  const attackerDuel = activeDuels.get(attacker.id);
  if (attackerDuel && getDuelOpponentId(attackerDuel, attacker.id) !== target.id) {
    bot.sendMessage(chatId, `${actorLabel}, ты сейчас на дуэли с ${getDuelOpponentLabel(attackerDuel, attacker.id)} — атакуй только его, пока дуэль не закончится.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  const targetDuel = activeDuels.get(target.id);
  if (targetDuel && getDuelOpponentId(targetDuel, target.id) !== attacker.id) {
    bot.sendMessage(chatId, `${targetLabel} сейчас на дуэли — нельзя вмешиваться.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isScaredOf(attacker.id, target.id)) {
    bot.sendMessage(chatId, `${actorLabel}, ты до смерти напуган(а) ссаным тапком ${targetLabel} — не подходи ещё немного!`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isHidden(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} прячется в чулане — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isInTree(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} сидит на дереве — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isHospitalized(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} лежит в больничке — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isParalyzed(target.id)) {
    bot.sendMessage(chatId, `${targetLabel} парализован(а) после /fuck — недоступен для удара.`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  const attackerHealth = getUserHealth(attacker.id);
  // Only reached when больничка couldn't be paid for on the way in (see
  // damageHuman) — a genuine hard block, unlike больничка's own
  // attacker handling further down, which allows attacking and ejects
  // early instead. Checked before isHospitalized below on the (very
  // rare, cross-bot-only) chance both were somehow true at once — either
  // order still refuses the attack correctly, this just picks which
  // message the player sees first.
  if (isKnockedOut(attacker.id)) {
    const knockoutRow = db.prepare('SELECT expires_at FROM mutes WHERE user_id = ?').get(attacker.id);
    const minutesLeft = knockoutRow && knockoutRow.expires_at ? Math.ceil((knockoutRow.expires_at * 1000 - Date.now()) / 60000) : null;
    const etaText = minutesLeft !== null ? ` ещё ${minutesLeft} мин` : '';
    bot.sendMessage(chatId, `${actorLabel}, твоя в отключке, какая драка!${etaText}`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  // Больничка's own early-discharge-by-attacking mechanic (see further
  // down, right before consumeEnergy) needs at least this much health —
  // below it, the attack is refused outright and больничка status stays.
  if (isHospitalized(attacker.id) && attackerHealth.health < HOSPITAL_MIN_DISCHARGE_HEALTH) {
    bot.sendMessage(chatId, `${actorLabel}, слишком слаб для драки — нужно хотя бы ${HOSPITAL_MIN_DISCHARGE_HEALTH} ХП, чтобы выписаться из больнички.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isStunned(attacker.id)) {
    const stunRow = db.prepare('SELECT stunned_until FROM user_health WHERE user_id = ?').get(attacker.id);
    const minutesLeft = Math.ceil((stunRow.stunned_until * 1000 - Date.now()) / 60000);
    bot.sendMessage(chatId, `${actorLabel}, ты оглушён битой — не можешь атаковать ещё ${minutesLeft} мин.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isParalyzed(attacker.id)) {
    const paralyzedRow = db.prepare('SELECT paralyzed_until FROM user_health WHERE user_id = ?').get(attacker.id);
    const minutesLeft = Math.ceil((paralyzedRow.paralyzed_until * 1000 - Date.now()) / 60000);
    bot.sendMessage(chatId, `${actorLabel}, ты парализован(а) после /fuck — не можешь атаковать ещё ${minutesLeft} мин.`, threadOpts(msgLike)).catch(() => {});
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
  // Deliberately keyed by weapon.key (bare type, e.g. 'knife'), not
  // weapon.instanceKey — holding several knives at once shares one
  // cooldown bucket across all of them. Keying by instanceKey instead
  // would let a player round-robin between several purchased knives to
  // bypass the cooldown entirely, which multi-instance knives were never
  // meant to buy (see docs/superpowers/specs/2026-08-25-knife-multi-
  // instance-design.md — the benefit is redundancy/tradeability, not
  // faster attacks).
  const weapon = pickWeaponForAttacker('human', attacker.id, slot, PVP_WEAPONS);
  let effectiveCooldownMs = Math.max(MIN_PVP_COOLDOWN_MS, PVP_COOLDOWN_MS * (1 - attackerStats.agility * AGILITY_COOLDOWN_PER_POINT));
  // Тапки — a physical pair swings twice as often as any other weapon,
  // clean or soiled (see WEAPON_DEFS.tapki); soiled additionally swaps
  // in the higher multiplier and flavor text right here, so every
  // downstream read (damage calc, the hit line itself) picks it up.
  if (weapon.key === 'tapki') {
    effectiveCooldownMs = Math.max(MIN_PVP_COOLDOWN_MS, effectiveCooldownMs / 2);
    if (isTapkiSoiled()) {
      weapon.multiplier = 1;
      weapon.text = 'ссаными тапками';
    }
  }
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
  if (isInTree(attacker.id)) {
    db.prepare('UPDATE user_health SET tree_until = NULL WHERE user_id = ?').run(attacker.id);
    await bot.sendMessage(chatId, `🌳 ${actorLabel} слезает с дерева, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
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

  // Катана — 3 fully independent swings (own roll, own crit/injury/XP
  // each) for this single energy/cooldown spend, instead of the usual
  // one. See performKatanaSwing; stops early if a swing floors the
  // target so the combo can't keep hitting a downed opponent.
  if (weapon.key === 'katana') {
    for (let i = 0; i < KATANA_SEGMENT_MULTIPLIERS.length; i++) {
      const healthAfter = await performKatanaSwing(
        chatId, msgLike, attacker, target, actorLabel, targetLabel, attackerStats, attackerInjury, KATANA_SEGMENT_MULTIPLIERS[i], i + 1
      );
      if (healthAfter === 0) break;
    }
    return;
  }

  const bodyPart = weapon.key === 'knuckles' ? 'по голове' : pick(PVP_BODY_PARTS);
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

  // Катана's passive block (see tryKatanaBlock) — only rolled if the hit
  // would otherwise land, since there's nothing to block on a miss/dodge.
  let blockedByKatana = false;
  if (success) {
    blockedByKatana = tryKatanaBlock(target.id);
    if (blockedByKatana) success = false;
  }

  const outcome = blockedByKatana ? '🗡️ заблокировано катаной!' : roll === 0 ? '❌ неудачно' : dodgedByDefender ? '🌀 уворот!' : '✅ удачно';
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
      if (weapon.instanceKey.startsWith('knife:')) {
        const knifeId = Number(weapon.instanceKey.slice('knife:'.length));
        db.prepare('UPDATE owned_knives SET owner_user_id = ?, owner_username = NULL, is_dropped = 1, dropped_chat_id = ? WHERE id = ?').run(attacker.id, chatId, knifeId);
      } else {
        db.prepare(
          "UPDATE weapon_ownership SET owner_type = 'dropped', owner_user_id = ?, owner_username = NULL, dropped_chat_id = ? WHERE weapon_key = ?"
        ).run(attacker.id, chatId, weapon.key);
      }
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
      const dmg = Math.round(rawDmg * 1.2 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в ухо! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'nose') {
      const dmg = Math.round(rawDmg * 1.2 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🥕 ${actorLabel} тычет ${targetLabel} морковкой в нос! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'mouth') {
      targetHealthAfter = Math.min(targetHealthBefore.max_health, targetHealthBefore.health + 15);
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
      // No heal anymore — purely a flavor outcome now, health untouched.
      targetHealthAfter = targetHealthBefore.health;
      await bot.sendMessage(chatId, `🥕😳 ${actorLabel} тычет ${targetLabel} морковкой... не туда! ${targetLabel} получает оргазм (${targetHealthBefore.health})!`, threadOpts(msgLike)).catch(() => {});
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
  } else if (weapon.key === 'dildo') {
    // Same 5-hole idea as carrot, plus a 6th (head) that stuns instead of
    // scaling damage — all 6 equally likely.
    const holes = ['ear', 'nose', 'mouth', 'pussy', 'ass', 'head'];
    hole = holes[Math.floor(Math.random() * holes.length)];
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    const insult = pick(DILDO_INSULTS);

    if (hole === 'ear') {
      const dmg = Math.round(rawDmg * 0.7 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🍆 ${actorLabel} тычет ${targetLabel} оранжевым дилдо в ухо! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter}). ${insult}`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'nose') {
      const dmg = Math.round(rawDmg * 0.5 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🍆 ${actorLabel} водит оранжевым дилдо у носа ${targetLabel}! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter}). ${insult}`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'mouth') {
      const dmg = Math.round(rawDmg * 0.7 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🍆 ${actorLabel} тычет ${targetLabel} оранжевым дилдо в рот! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter}). ${insult}`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'pussy') {
      const dmg = Math.round(rawDmg * 0.5 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🍆 ${actorLabel} тычет ${targetLabel} оранжевым дилдо в письку! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter}). ${insult}`, threadOpts(msgLike)).catch(() => {});
    } else if (hole === 'ass') {
      const dmg = Math.round(rawDmg * 3 * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      await bot.sendMessage(chatId, `🍆 ${actorLabel} загоняет ${targetLabel} оранжевое дилдо в попку! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter}). ${insult}`, threadOpts(msgLike)).catch(() => {});
    } else {
      // head — standard (×1) damage, plus a guaranteed 2-min stun. Same
      // stunned_until column as bat's own 30%-chance stun.
      const dmg = Math.round(rawDmg * strengthFactor * armInjuryFactor * defendFactor);
      targetHealthAfter = damageHuman(target.id, chatId, target.username || target.firstName, dmg);
      const stunnedUntil = Math.floor(Date.now() / 1000) + 2 * 60;
      db.prepare('UPDATE user_health SET stunned_until = ? WHERE user_id = ?').run(stunnedUntil, target.id);
      await bot.sendMessage(chatId, `🍆 ${actorLabel} огревает ${targetLabel} оранжевым дилдо по голове! Урон: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter}). Оглушён на 2 минуты!`, threadOpts(msgLike)).catch(() => {});
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

  if (weapon.key === 'knuckles' && maybeKnockOutTooth(target.id)) {
    await bot.sendMessage(chatId, `🦷 Кастет выбил ${targetLabel} зуб — теряет 1 энергии!`, threadOpts(msgLike)).catch(() => {});
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

  if (weapon.key === 'claws') {
    const scratchPhrase = pick(CLAW_HIT_PHRASES).replace('{target}', targetLabel);
    await bot.sendMessage(chatId, `🐾 ${actorLabel} ${scratchPhrase}!`, threadOpts(msgLike)).catch(() => {});

    if (Math.random() < 0.2) {
      // Arousal proc — forces the victim into an unwilling /fuck attempt
      // against a random OTHER warrior. Same 40%-success/10-40-min-
      // paralysis shape as the real /fuck command, but no energy cost
      // (the victim didn't choose this) and no eligibility gate on the
      // random target — this is a chaos effect, not a deliberate action.
      const warriorIds = db.prepare('SELECT user_id FROM pvp_stats WHERE is_warrior = 1').all()
        .map((r) => r.user_id)
        .filter((id) => id !== target.id);
      if (warriorIds.length > 0) {
        const randomWarriorId = warriorIds[Math.floor(Math.random() * warriorIds.length)];
        const randomWarriorLabel = labelForUserId(randomWarriorId);
        if (Math.random() < FUCK_SUCCESS_CHANCE) {
          const paralysisMinutes = rollFuckParalysisMinutes();
          const until = Math.floor(Date.now() / 1000) + paralysisMinutes * 60;
          db.prepare('UPDATE user_health SET paralyzed_until = ? WHERE user_id = ?').run(until, randomWarriorId);
          ensureStatsRow(target.id);
          db.prepare('UPDATE pvp_stats SET xp = xp + ? WHERE user_id = ?').run(FUCK_XP_GAIN, target.id);
          await bot.sendMessage(chatId, `😾🔥 Царапины возбуждают ${targetLabel}! ${targetLabel} набрасывается на ${randomWarriorLabel} — тот(та) парализован(а) на ${paralysisMinutes} мин.`, threadOpts(msgLike)).catch(() => {});
        } else {
          await bot.sendMessage(chatId, `😾🔥 Царапины возбуждают ${targetLabel}! ${targetLabel} набрасывается на ${randomWarriorLabel}, но ничего не вышло.`, threadOpts(msgLike)).catch(() => {});
        }
      }
    }

    if (Math.random() < 0.2) {
      // Poison proc — two delayed ticks ~1 min apart, 1-10 HP each,
      // independent of scissors' own repeating bleed drain (applyBleed).
      await bot.sendMessage(chatId, `☠️ Когти были ядовитыми — ${targetLabel} начинает мутить!`, threadOpts(msgLike)).catch(() => {});
      for (const delayMs of [60 * 1000, 120 * 1000]) {
        setTimeout(() => {
          if (getUserHealth(target.id).health === 0) return;
          const poisonDmg = randIntInclusive(1, 10);
          const before = getUserHealth(target.id).health;
          const after = damageHuman(target.id, chatId, target.username || target.firstName, poisonDmg);
          bot.sendMessage(chatId, `☠️ Яд когтей: -${poisonDmg} хп у ${targetLabel} (${before} -> ${after})`, threadOpts(msgLike)).catch(() => {});
        }, delayMs);
      }
    }
  }

  // Ссаные тапки's 3 independent 20% procs — clean тапки (isTapkiSoiled
  // false) gets none of this, just the flat 0.7x multiplier and doubled
  // attack rate from the weapon.key === 'tapki' block up above.
  if (weapon.key === 'tapki' && isTapkiSoiled()) {
    if (Math.random() < 0.2) {
      const stunnedUntil = Math.floor(Date.now() / 1000) + 2 * 60;
      db.prepare('UPDATE user_health SET stunned_until = ? WHERE user_id = ?').run(stunnedUntil, target.id);
      await bot.sendMessage(chatId, `🥿😵 ${actorLabel} оглушил(а) ${targetLabel} ссаным тапком! Не сможет атаковать 2 минуты.`, threadOpts(msgLike)).catch(() => {});
    }

    if (Math.random() < 0.2) {
      // Scare — unlike a stun, this doesn't block the target from
      // attacking anyone in general, only THIS specific attacker (see
      // isScaredOf and its gate up near the duel-exclusivity checks).
      const scaredUntil = Math.floor(Date.now() / 1000) + 3 * 60;
      db.prepare('UPDATE user_health SET scared_of_user_id = ?, scared_until = ? WHERE user_id = ?').run(attacker.id, scaredUntil, target.id);
      await bot.sendMessage(chatId, `🥿😱 ${actorLabel} напугал(а) ${targetLabel} ссаным тапком! ${targetLabel} не сможет ударить ${actorLabel} 3 минуты.`, threadOpts(msgLike)).catch(() => {});
    }

    if (Math.random() < 0.2) {
      // Throw — a stray flying tapok reaches someone normally
      // unreachable (hidden/treed/hospitalized), bypassing all three
      // protections at once. Fully independent of the main hit above:
      // its own fresh damage roll, on a completely different random
      // victim, target untouched.
      const candidates = db.prepare('SELECT user_id FROM pvp_stats WHERE is_warrior = 1').all()
        .map((r) => r.user_id)
        .filter((id) => isHidden(id) || isInTree(id) || isHospitalized(id));
      if (candidates.length > 0) {
        const flungAtId = candidates[Math.floor(Math.random() * candidates.length)];
        const flungAtLabel = labelForUserId(flungAtId);
        const rawThrowDmg = Math.floor(Math.random() * 20) + 1;
        const throwDmg = Math.round(rawThrowDmg * weapon.multiplier * strengthFactor * armInjuryFactor);
        const flungHealthBefore = getUserHealth(flungAtId).health;
        const flungHealthAfter = damageHuman(flungAtId, chatId, null, throwDmg);
        await bot.sendMessage(
          chatId,
          `🥿💥 ${actorLabel} кинул(а) ссаный тапок — прилетело ${flungAtLabel}, хоть и прятался(-лась)! Урон: ${throwDmg} (${flungHealthBefore} -> ${flungHealthAfter})`,
          threadOpts(msgLike)
        ).catch(() => {});
      }
    }
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
    // Кастет always connects with the head — on a crit that means a
    // guaranteed 'head' injury instead of the usual random arm/leg/head
    // pick, unlike every other weapon here.
    const injuryType = weapon.key === 'knuckles' ? 'head' : pick(['arm', 'leg', 'head']);
    const healMinutes = applyInjury(target.id, injuryType);
    recordInjuryDealt(attacker.id);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      chatId,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healMinutes} мин).`,
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
    // damageHuman already decided (and paid for, or didn't) больничка
    // entry — isHospitalized(target.id) here just reads back which of
    // its two branches actually fired, no re-deciding.
    if (isHospitalized(target.id)) {
      await bot.sendMessage(
        chatId,
        `🏥 ${targetLabel} без сознания и попадает в больничку (−1 монета из кошелька) — недоступен для удара, пока не наберёт ${HOSPITAL_EXIT_HEALTH} ХП (или сам не решит атаковать раньше, если наберётся хотя бы ${HOSPITAL_MIN_DISCHARGE_HEALTH} ХП).`,
        threadOpts(msgLike)
      ).catch(() => {});
    } else {
      await bot.sendMessage(
        chatId,
        `😵 ${targetLabel} без сознания, но денег на больничку нет — остаётся на улице, замьючен(а) на 30 мин (не может атаковать).`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
    const heldWeapons = getWeaponsFor('human', target.id);
    const victimCoinsRow = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(target.id);
    const victimCoins = victimCoinsRow ? victimCoinsRow.coins : 0;
    if (heldWeapons.length > 0 || victimCoins > 0) {
      const itemParts = heldWeapons.map(row => WEAPON_DEFS[row.weapon_key].accusative);
      if (victimCoins > 0) itemParts.push('кошелёк');
      const itemsText = itemParts.length === 1
        ? itemParts[0]
        : itemParts.slice(0, -1).join(', ') + ' и ' + itemParts[itemParts.length - 1];
      const question = itemParts.length === 1 ? 'Забрать?' : 'Что забрать?';
      const buttons = heldWeapons.map(row => [{
        text: `🗡 Забрать ${WEAPON_DEFS[row.weapon_key].accusative}`,
        callback_data: `steal_yes:${attacker.id}:${target.id}:${row.instanceKey}`,
      }]);
      if (victimCoins > 0) {
        buttons.push([{ text: '🪙 Обшарить кошель', callback_data: `steal_coins:${attacker.id}:${target.id}` }]);
      }
      buttons.push([{ text: '🤝 Оставить', callback_data: `steal_no:${attacker.id}` }]);
      await bot.sendMessage(
        chatId,
        `${targetLabel} в отключке — с ним ${itemsText}. ${question}`,
        threadOpts(msgLike, { reply_markup: { inline_keyboard: buttons } })
      ).catch(() => {});
    }
  }

  // Duel death check — if this hit landed on the attacker's own duel
  // opponent and floored them, the duel is over right now rather than
  // waiting for the 5-minute timer. Deliberately after the knockout/
  // steal-offer messaging above, so the duel-end announcement reads as
  // the last word on this exchange.
  const finishedDuel = activeDuels.get(attacker.id);
  if (targetHealthAfter === 0 && finishedDuel && getDuelOpponentId(finishedDuel, attacker.id) === target.id) {
    const bankText = finishedDuel.stake > 0 ? ` Банк ${finishedDuel.stake * 2} монет забирает победитель!` : '';
    endDuel(finishedDuel, `⚔️🏆 Дуэль окончена! ${actorLabel} добивает ${targetLabel} и побеждает!${bankText}`, attacker.id);
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
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const slot = match[1] ? parseInt(match[1], 10) : 0;

  // Goblin resolution first (see /goblinraid above) — cheap and
  // synchronous, so it's checked before the human path's own
  // bot.getChat() round-trip. Goblin names are Cyrillic and can never
  // collide with a real Telegram @username (Latin-only), so there's no
  // ambiguity between the two target kinds. A reply to one of the
  // goblin's own messages must be caught here too — otherwise it'd fall
  // through to the human branch below and resolve the target as the bot
  // itself (whoever sent that message).
  if (goblinRaid) {
    let goblin = null;
    const isPhantomGoblinTopicReply = msg.reply_to_message && msg.message_thread_id && msg.reply_to_message.message_id === msg.message_thread_id;
    if (msg.reply_to_message && !isPhantomGoblinTopicReply) {
      const goblinId = goblinMessageIds.get(msg.reply_to_message.message_id);
      if (goblinId) goblin = goblinRaid.goblins.get(goblinId);
    }
    if (!goblin && match[2]) {
      const name = match[2].replace(/^@/, '').trim().toLowerCase();
      goblin = [...goblinRaid.goblins.values()].find((g) => g.name.toLowerCase() === name);
    }
    if (goblin) {
      await performKickGoblin(msg.chat.id, msg, { id: msg.from.id, username: msg.from.username, firstName: msg.from.first_name }, goblin, slot);
      return;
    }
  }

  let target = null;
  // See /give's identical guard above (same copy-pasted target-resolution
  // snippet) for why this check exists: forum topics auto-attach a
  // reply_to_message pointing at the topic's own opening message on every
  // plain post, which would otherwise silently override @username here.
  const isPhantomTopicReply = msg.reply_to_message && msg.message_thread_id && msg.reply_to_message.message_id === msg.message_thread_id;
  if (msg.reply_to_message && msg.reply_to_message.from && !isPhantomTopicReply) {
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

// /duel — explicit-consent 1v1 challenge (see activeDuels/pendingDuels
// above for the state and the mutual-lock enforcement wired into
// performKick). Target resolution copied from /kick/give, including the
// same phantom-topic-reply guard (see its comment on /kick above) — a
// plain "/duel @username" posted fresh in "Поединки" would otherwise get
// its target silently overridden by Telegram's own auto-reply-to-topic-
// root quirk.
// Args accept the target and an optional coin stake in either order
// ("@user 100" or "100 @user"), so it's parsed as free-form tokens rather
// than baked into the regex itself — a bare numeric token is unambiguous
// either way, since Telegram usernames can never be all-digits.
bot.onText(/\/duel\b(?:@\w+)?(?:\s+(.+))?/, async (msg, match) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  const tokens = (match[1] || '').trim().split(/\s+/).filter(Boolean);
  let handle = null;
  let stakeAmount = 0;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      stakeAmount = parseInt(token, 10);
    } else if (!handle) {
      handle = token.replace(/^@/, '');
    }
  }

  let target = null;
  const isPhantomTopicReply = msg.reply_to_message && msg.message_thread_id && msg.reply_to_message.message_id === msg.message_thread_id;
  if (msg.reply_to_message && msg.reply_to_message.from && !isPhantomTopicReply) {
    target = {
      id: msg.reply_to_message.from.id,
      username: msg.reply_to_message.from.username,
      firstName: msg.reply_to_message.from.first_name,
    };
  } else if (handle) {
    try {
      const chat = await bot.getChat('@' + handle);
      target = { id: chat.id, username: chat.username, firstName: chat.first_name };
    } catch {}
  }
  if (!target) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, укажи @юзернейм (и, если хочешь, ставку монет) или ответь на сообщение того, кого вызываешь.`, threadOpts(msg)).catch(() => {});
  }
  const targetLabel = target.username ? `@${target.username}` : target.firstName;

  if (target.id === msg.from.id) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, нельзя вызвать на дуэль самого себя.`, threadOpts(msg)).catch(() => {});
  }
  if (!isWarrior(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, сначала стань воином: /warrior.`, threadOpts(msg)).catch(() => {});
  }
  if (!isWarrior(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} ещё не воин — его нельзя вызвать на дуэль.`, threadOpts(msg)).catch(() => {});
  }
  // Same "just landed a hit" lockout /hide uses — a duel is just as much
  // a fresh commitment as ducking into the чулан right after a fight.
  const lastAttack = combatLockouts.get(msg.from.id);
  if (lastAttack && Date.now() - lastAttack < NO_HIDE_AFTER_ATTACK_MS) {
    const remaining = Math.ceil((NO_HIDE_AFTER_ATTACK_MS - (Date.now() - lastAttack)) / 60000);
    return bot.sendMessage(msg.chat.id, `${actorLabel}, только что дрался — нельзя вызывать на дуэль ещё ${remaining} мин.`, threadOpts(msg)).catch(() => {});
  }
  if (activeDuels.has(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, ты уже на дуэли.`, threadOpts(msg)).catch(() => {});
  }
  if (activeDuels.has(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} сейчас на дуэли с кем-то другим.`, threadOpts(msg)).catch(() => {});
  }
  if (pendingDuels.has(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, у тебя уже есть неотвеченный вызов.`, threadOpts(msg)).catch(() => {});
  }
  if (pendingDuels.has(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} уже ждёт ответа на другой вызов.`, threadOpts(msg)).catch(() => {});
  }
  if (isHospitalized(msg.from.id) || isKnockedOut(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, ты не в состоянии драться — сначала долечись.`, threadOpts(msg)).catch(() => {});
  }
  if (isHospitalized(target.id) || isKnockedOut(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} не в состоянии драться — сначала долечится.`, threadOpts(msg)).catch(() => {});
  }

  // Escrow the challenger's stake right now, before the challenge even
  // goes out — refunded on decline/expiry/cancellation (see the timer
  // below and /duelaccept's own failure paths), paid out in full (both
  // sides' stakes) to whoever wins once the duel actually ends.
  if (stakeAmount > 0) {
    ensureStatsRow(msg.from.id);
    const paid = db.prepare('UPDATE pvp_stats SET coins = coins - ? WHERE user_id = ? AND coins >= ? RETURNING coins').get(stakeAmount, msg.from.id, stakeAmount);
    if (!paid) {
      return bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает монет на ставку ${stakeAmount} — глянь /wallet.`, threadOpts(msg)).catch(() => {});
    }
  }

  const timer = setTimeout(() => {
    pendingDuels.delete(target.id);
    if (stakeAmount > 0) {
      db.prepare('UPDATE pvp_stats SET coins = coins + ? WHERE user_id = ?').run(stakeAmount, msg.from.id);
    }
    bot.sendMessage(msg.chat.id, `⌛ Вызов на дуэль от ${actorLabel} к ${targetLabel} истёк.${stakeAmount > 0 ? ' Ставка возвращена.' : ''}`, threadOpts(msg)).catch(() => {});
  }, DUEL_CHALLENGE_EXPIRY_MS);

  pendingDuels.set(target.id, {
    challengerId: msg.from.id,
    challengerLabel: actorLabel,
    targetLabel,
    chatId: msg.chat.id,
    threadId: msg.message_thread_id || null,
    stake: stakeAmount,
    timer,
  });

  const stakeText = stakeAmount > 0 ? ` На кону ${stakeAmount} монет с каждого — победитель заберёт весь банк (${stakeAmount * 2}).` : '';
  bot.sendMessage(
    msg.chat.id,
    `⚔️ ${actorLabel} вызывает ${targetLabel} на дуэль 1 на 1!${stakeText} Пока она идёт — никто третий не может атаковать вас, и вы не можете атаковать никого другого, эликсиры тоже под запретом. Конец — либо чья-то смерть, либо 5 минут (тогда победа за тем, у кого больше HP). ${targetLabel}, 2 минуты, чтобы принять: /duelaccept`,
    threadOpts(msg)
  ).catch(() => {});
});

// /duelaccept — the challenged player confirms /duel above. Re-checks
// both sides can still actually fight, since up to 2 minutes can pass
// between the challenge and this — plenty of time for either of them to
// get knocked into another duel, hospitalized, or knocked out by someone
// else entirely in the meantime.
bot.onText(/\/duelaccept\b/i, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const pending = pendingDuels.get(msg.from.id);
  if (!pending) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, тебя никто не вызывал на дуэль.`, threadOpts(msg)).catch(() => {});
  }
  clearTimeout(pending.timer);
  pendingDuels.delete(msg.from.id);

  // From here on, any early return is a cancellation (not a "try again
  // later" — the pending slot above is already gone), so the
  // challenger's escrowed stake has to come back to them right here.
  const refundChallenger = () => {
    if (pending.stake > 0) {
      db.prepare('UPDATE pvp_stats SET coins = coins + ? WHERE user_id = ?').run(pending.stake, pending.challengerId);
    }
  };

  if (activeDuels.has(pending.challengerId) || activeDuels.has(msg.from.id)) {
    refundChallenger();
    return bot.sendMessage(msg.chat.id, `${actorLabel}, один из вас уже успел ввязаться в другую дуэль — вызов отменён.${pending.stake > 0 ? ' Ставка возвращена.' : ''}`, threadOpts(msg)).catch(() => {});
  }
  if (isHospitalized(pending.challengerId) || isKnockedOut(pending.challengerId) || isHospitalized(msg.from.id) || isKnockedOut(msg.from.id)) {
    refundChallenger();
    return bot.sendMessage(msg.chat.id, `${actorLabel}, кто-то из вас сейчас не в состоянии драться — вызов отменён.${pending.stake > 0 ? ' Ставка возвращена.' : ''}`, threadOpts(msg)).catch(() => {});
  }
  if (pending.stake > 0) {
    ensureStatsRow(msg.from.id);
    const paid = db.prepare('UPDATE pvp_stats SET coins = coins - ? WHERE user_id = ? AND coins >= ? RETURNING coins').get(pending.stake, msg.from.id, pending.stake);
    if (!paid) {
      refundChallenger();
      return bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает монет на ставку ${pending.stake} — вызов отменён, ставка возвращена ${pending.challengerLabel}.`, threadOpts(msg)).catch(() => {});
    }
  }

  const duel = {
    aId: pending.challengerId,
    aLabel: pending.challengerLabel,
    bId: msg.from.id,
    bLabel: actorLabel,
    chatId: pending.chatId,
    threadId: pending.threadId,
    stake: pending.stake,
    startedAt: Date.now(),
  };
  duel.timer = setTimeout(() => resolveDuelTimeout(duel), DUEL_DURATION_MS);
  activeDuels.set(duel.aId, duel);
  activeDuels.set(duel.bId, duel);

  const stakeText = pending.stake > 0 ? ` На кону ${pending.stake * 2} монет (по ${pending.stake} с каждого).` : '';
  bot.sendMessage(
    pending.chatId,
    `⚔️✅ ${actorLabel} принимает вызов! Дуэль между ${pending.challengerLabel} и ${actorLabel} началась — 5 минут, до смерти или до сравнения HP.${stakeText}`,
    pending.threadId ? { message_thread_id: pending.threadId } : {}
  ).catch(() => {});
});

// /fuck — a warrior attempts to have sex with an opponent: 40% success,
// 50% nothing happens, 10% it backfires and the ATTACKER paralyzes
// themselves instead — costs 3 energy regardless of outcome. On success
// the victim gets a 10-40 min paralysis (see isParalyzed) — locked out
// of combat entirely in both directions (can't attack, can't be
// attacked), unlike a stun which only blocks attacking; the backfire
// outcome applies that exact same paralysis to the attacker instead,
// with no effect on the target at all. Confined to "Поединки" and gated
// the same way as /kick (both sides must be warriors, respects duel
// exclusivity, target can't already be hidden/hospitalized/paralyzed) —
// same target resolution as /kick/duel, including the phantom-topic-
// reply guard.
const FUCK_ENERGY_COST = 3;
const FUCK_SUCCESS_CHANCE = 0.4;
const FUCK_SELF_ORGASM_CHANCE = 0.1;
const FUCK_PARALYSIS_MIN_MINUTES = 10;
const FUCK_PARALYSIS_MAX_MINUTES = 40;
const FUCK_XP_GAIN = 3;
// Rolled fresh per success (both the player command below and the
// goblin/orc attempt in goblinTick) rather than a flat duration.
function rollFuckParalysisMinutes() {
  return FUCK_PARALYSIS_MIN_MINUTES + Math.floor(Math.random() * (FUCK_PARALYSIS_MAX_MINUTES - FUCK_PARALYSIS_MIN_MINUTES + 1));
}
bot.onText(/\/fuck\b(?:@\w+)?(?:\s+@?(\S+))?/, async (msg, match) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  if (msg.chat.id !== ARENA_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, 'Это разрешено только в чате «Поединки».', threadOpts(msg)).catch(() => {});
  }
  const actorLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  let target = null;
  const isPhantomTopicReply = msg.reply_to_message && msg.message_thread_id && msg.reply_to_message.message_id === msg.message_thread_id;
  if (msg.reply_to_message && msg.reply_to_message.from && !isPhantomTopicReply) {
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
  if (!target) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, укажи @юзернейм или ответь на сообщение того, кого хочешь трахнуть.`, threadOpts(msg)).catch(() => {});
  }
  const targetLabel = target.username ? `@${target.username}` : target.firstName;

  if (target.id === msg.from.id) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, себя-то зачем?`, threadOpts(msg)).catch(() => {});
  }
  if (!isWarrior(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, сначала стань воином: /warrior.`, threadOpts(msg)).catch(() => {});
  }
  if (!isWarrior(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} ещё не воин — его нельзя трогать.`, threadOpts(msg)).catch(() => {});
  }

  const attackerDuel = activeDuels.get(msg.from.id);
  if (attackerDuel && getDuelOpponentId(attackerDuel, msg.from.id) !== target.id) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, ты сейчас на дуэли с ${getDuelOpponentLabel(attackerDuel, msg.from.id)} — занимайся только им, пока дуэль не закончится.`, threadOpts(msg)).catch(() => {});
  }
  const targetDuel = activeDuels.get(target.id);
  if (targetDuel && getDuelOpponentId(targetDuel, target.id) !== msg.from.id) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} сейчас на дуэли — нельзя вмешиваться.`, threadOpts(msg)).catch(() => {});
  }

  if (isHidden(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} прячется в чулане — недоступен(на).`, threadOpts(msg)).catch(() => {});
  }
  if (isInTree(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} сидит на дереве — недоступен(на).`, threadOpts(msg)).catch(() => {});
  }
  if (isHospitalized(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} лежит в больничке — недоступен(на).`, threadOpts(msg)).catch(() => {});
  }
  if (isParalyzed(target.id)) {
    return bot.sendMessage(msg.chat.id, `${targetLabel} уже парализован(а) — недоступен(на).`, threadOpts(msg)).catch(() => {});
  }
  if (isKnockedOut(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, твоя в отключке, какое там.`, threadOpts(msg)).catch(() => {});
  }
  if (isHospitalized(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, ты в больничке — не до того.`, threadOpts(msg)).catch(() => {});
  }
  if (isStunned(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, ты оглушён(а) — не до того.`, threadOpts(msg)).catch(() => {});
  }
  if (isParalyzed(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, ты сам(а) парализован(а) — не до того.`, threadOpts(msg)).catch(() => {});
  }

  const health = getUserHealth(msg.from.id);
  if (health.energy < FUCK_ENERGY_COST) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, не хватает энергии (нужно ${FUCK_ENERGY_COST}, есть ${health.energy}).`, threadOpts(msg)).catch(() => {});
  }
  const cooldownRemaining = checkPvpCooldown(msg.from.id, 'fuck', PVP_COOLDOWN_MS);
  if (cooldownRemaining > 0) {
    return bot.sendMessage(msg.chat.id, `${actorLabel}, подожди ещё ${cooldownRemaining} сек.`, threadOpts(msg)).catch(() => {});
  }

  consumeEnergy(msg.from.id, FUCK_ENERGY_COST);

  const outcomeRoll = Math.random();
  if (outcomeRoll < FUCK_SUCCESS_CHANCE && tryKatanaBlock(target.id)) {
    // Катана's passive block also covers a would-be-successful /fuck —
    // see tryKatanaBlock. Energy's already spent either way.
    await bot.sendMessage(msg.chat.id, `🗡️ ${targetLabel} блокирует катаной — ${actorLabel} остаётся ни с чем.`, threadOpts(msg)).catch(() => {});
  } else if (outcomeRoll < FUCK_SUCCESS_CHANCE) {
    const paralysisMinutes = rollFuckParalysisMinutes();
    const until = Math.floor(Date.now() / 1000) + paralysisMinutes * 60;
    db.prepare('UPDATE user_health SET paralyzed_until = ? WHERE user_id = ?').run(until, target.id);
    ensureStatsRow(msg.from.id);
    db.prepare('UPDATE pvp_stats SET xp = xp + ? WHERE user_id = ?').run(FUCK_XP_GAIN, msg.from.id);
    await bot.sendMessage(
      msg.chat.id,
      `😳 ${actorLabel} трахает ${targetLabel}! ${targetLabel} получает мощнейший оргазм и парализован(а) на ${paralysisMinutes} мин — не может ни бить, ни быть избитым(ой).`,
      threadOpts(msg)
    ).catch(() => {});
  } else if (outcomeRoll < FUCK_SUCCESS_CHANCE + FUCK_SELF_ORGASM_CHANCE) {
    // Backfire — the attacker gets too excited and finishes first, same
    // paralysis effect as a normal success but landing on THEM instead;
    // target is untouched, no XP either (this is a bad outcome).
    const paralysisMinutes = rollFuckParalysisMinutes();
    const until = Math.floor(Date.now() / 1000) + paralysisMinutes * 60;
    db.prepare('UPDATE user_health SET paralyzed_until = ? WHERE user_id = ?').run(until, msg.from.id);
    await bot.sendMessage(
      msg.chat.id,
      `😳💦 ${actorLabel} занимается сексом с ${targetLabel}, но не сдержался(-лась) и словил(а) оргазм раньше времени! Сам(а) парализован(а) на ${paralysisMinutes} мин.`,
      threadOpts(msg)
    ).catch(() => {});
  } else {
    await bot.sendMessage(msg.chat.id, `😅 ${actorLabel} пытается трахнуть ${targetLabel}, но ничего не вышло.`, threadOpts(msg)).catch(() => {});
  }
});

// /goblinraid <уровень> — admin-only, starts a raid at one of the 4
// preset tiers in RAID_TIERS above (defaults to 'рейд' if no tier is
// given). Goblin/orc counts are each rolled independently within that
// tier's [min, max] range. Refuses if a raid's already running rather
// than spawning a second overlapping wave.
bot.onText(/\/goblinraid\b(?:\s+(\S+))?/i, async (msg, match) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
  if (!(await isAdmin(msg))) return;
  if (goblinRaid) {
    return bot.sendMessage(msg.chat.id, 'Набег уже идёт.', threadOpts(msg)).catch(() => {});
  }
  const tierName = (match[1] || 'рейд').toLowerCase();

  // Тролль/тролленок — standalone boss tiers, not drawn from RAID_TIERS'
  // goblin/orc [min,max] shape at all: exactly one, own faster tick
  // function (trollTick, not goblinTick — see its own targeting/
  // чулан-break logic), same fleeTimer mechanism the scheduled recon
  // already uses for its own time limit.
  const TROLL_TIER_TO_TYPE = { 'тролль': 'troll', 'тролленок': 'troll_young' };
  if (TROLL_TIER_TO_TYPE[tierName]) {
    const troll = spawnMonster(TROLL_TIER_TO_TYPE[tierName], 0);
    const def = MONSTER_TYPES[troll.type];
    const goblins = new Map([[troll.id, troll]]);
    goblinRaid = {
      goblins,
      chatId: msg.chat.id,
      threadId: msg.message_thread_id || null,
      tickTimer: setInterval(trollTick, TROLL_ATTACK_INTERVAL_MS),
      fleeTimer: setTimeout(endGoblinRaidByFlee, TROLL_DURATION_MS),
    };
    await bot.sendMessage(
      msg.chat.id,
      `${def.emoji} ${troll.name.toUpperCase()}! Из-под моста вылезает ${troll.name.toLowerCase()} с дубиной (${troll.maxHealth} ХП). Бьёт сразу ${def.swingTargets === 2 ? 'двоих' : 'троих'} раз в 30 сек, регенерирует ${def.regenPerTick} ХП каждые ${def.regenIntervalMs / 1000} сек, и раз в несколько ударов сносит чулан со всеми, кто там прячется. Не убьёте за 15 минут — сбежит. Бей через /kick ${troll.name} (или ответом на его сообщение об ударе).`,
      threadOpts(msg)
    ).catch(() => {});
    return;
  }

  const tier = RAID_TIERS[tierName];
  if (!tier) {
    return bot.sendMessage(msg.chat.id, `Неизвестный уровень набега. Варианты: ${Object.keys(RAID_TIERS).join(', ')}, ${Object.keys(TROLL_TIER_TO_TYPE).join(', ')}.`, threadOpts(msg)).catch(() => {});
  }

  const goblinCount = randIntInclusive(tier.goblins[0], tier.goblins[1]);
  const orcCount = randIntInclusive(tier.orcs[0], tier.orcs[1]);

  const goblins = new Map();
  for (let i = 0; i < goblinCount; i++) {
    const m = spawnMonster('goblin', i);
    goblins.set(m.id, m);
  }
  for (let i = 0; i < orcCount; i++) {
    const m = spawnMonster('orc', i);
    goblins.set(m.id, m);
  }

  goblinRaid = {
    goblins,
    chatId: msg.chat.id,
    threadId: msg.message_thread_id || null,
    tickTimer: setInterval(goblinTick, GOBLIN_ATTACK_INTERVAL_MS),
  };

  const raidLabel = tierName.charAt(0).toUpperCase() + tierName.slice(1);
  const roster = [...goblins.values()].map((m) => `${MONSTER_TYPES[m.type].emoji} ${m.name} (${m.maxHealth} ХП)`).join('\n');
  const summary = orcCount > 0 ? `${goblinCount} гоблинов и ${orcCount} орков` : `${goblinCount} гоблинов`;
  bot.sendMessage(
    msg.chat.id,
    `👹 ${raidLabel}! На чат напало: ${summary}:\n${roster}\n\nБей их через /kick <имя> (или ответом на сообщение об их ударе) — так же, как обычного игрока: те же шансы попасть/увернуться и то же оружие. У каждого 3-10 монет — забираешь всё при убийстве.`,
    threadOpts(msg)
  ).catch(() => {});
});

// /goblins — public status listing, since goblin HP/energy otherwise
// only ever shows up scattered across combat log messages.
bot.onText(/\/goblins\b/i, (msg) => {
  if (!goblinRaid) {
    return bot.sendMessage(msg.chat.id, 'Сейчас нет набега.', threadOpts(msg)).catch(() => {});
  }
  const lines = [...goblinRaid.goblins.values()].map((g) => {
    if (g.health <= 0) return `💀 ${g.name} — мёртв`;
    const emoji = MONSTER_TYPES[g.type].emoji;
    // Тролль/тролленок have no locked target (fresh random targets every
    // swing) and infinite energy — the goblin/orc-style "⚡N → бьёт X"
    // line doesn't apply to them.
    if (TROLL_TYPES.has(g.type)) {
      const swingTargets = MONSTER_TYPES[g.type].swingTargets;
      return `${emoji} ${g.name} — ${g.health}/${g.maxHealth} ХП, бьёт сразу ${swingTargets === 2 ? 'двоих' : 'троих'} раз в 30 сек`;
    }
    const targetText = g.targetUserId ? ` → бьёт ${labelForUserId(g.targetUserId)}` : ' → ждёт цель';
    return `${emoji} ${g.name} — ${g.health}/${g.maxHealth} ХП, ⚡${g.energy}${targetText}`;
  });
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});

// Fighting a goblin or orc goes through /kick itself (see its onText
// handler below, which routes here instead of performKick when the
// resolved target is a monster rather than a human) — same command,
// same weapon slots, same opposed accuracy-vs-dodge roll as human PvP,
// just against that monster's own MONSTER_TYPES stats instead of a real
// user's getStats(). No arm/leg/head injury on the monster's own side
// (it doesn't have any), so no crit-
// injury infliction and none of a real weapon's other human-only procs
// (crutch/horns/bat-stun/carrot-holes/knuckles-headshot/etc. all write
// to user_health columns a goblin doesn't have) — only the weapon's flat
// multiplier counts. XP/crit tracking for the attacker still applies in
// full, same as fighting a human.
async function performKickGoblin(chatId, msgLike, attacker, goblin, slot) {
  const actorLabel = attacker.username ? `@${attacker.username}` : attacker.firstName;
  const monsterDef = MONSTER_TYPES[goblin.type];

  if (goblin.health <= 0) {
    bot.sendMessage(chatId, `${actorLabel}, ${goblin.name} уже мёртв.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (!isWarrior(attacker.id)) {
    bot.sendMessage(chatId, `${actorLabel}, ты ещё не воин — введи /warrior, чтобы начать драться.`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  const attackerHealth = getUserHealth(attacker.id);
  if (isKnockedOut(attacker.id)) {
    const knockoutRow = db.prepare('SELECT expires_at FROM mutes WHERE user_id = ?').get(attacker.id);
    const minutesLeft = knockoutRow && knockoutRow.expires_at ? Math.ceil((knockoutRow.expires_at * 1000 - Date.now()) / 60000) : null;
    const etaText = minutesLeft !== null ? ` ещё ${minutesLeft} мин` : '';
    bot.sendMessage(chatId, `${actorLabel}, твоя в отключке, какая драка!${etaText}`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isHospitalized(attacker.id) && attackerHealth.health < HOSPITAL_MIN_DISCHARGE_HEALTH) {
    bot.sendMessage(chatId, `${actorLabel}, слишком слаб для драки — нужно хотя бы ${HOSPITAL_MIN_DISCHARGE_HEALTH} ХП, чтобы выписаться из больнички.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isStunned(attacker.id)) {
    const stunRow = db.prepare('SELECT stunned_until FROM user_health WHERE user_id = ?').get(attacker.id);
    const minutesLeft = Math.ceil((stunRow.stunned_until * 1000 - Date.now()) / 60000);
    bot.sendMessage(chatId, `${actorLabel}, ты оглушён битой — не можешь атаковать ещё ${minutesLeft} мин.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (isParalyzed(attacker.id)) {
    const paralyzedRow = db.prepare('SELECT paralyzed_until FROM user_health WHERE user_id = ?').get(attacker.id);
    const minutesLeft = Math.ceil((paralyzedRow.paralyzed_until * 1000 - Date.now()) / 60000);
    bot.sendMessage(chatId, `${actorLabel}, ты парализован(а) после /fuck — не можешь атаковать ещё ${minutesLeft} мин.`, threadOpts(msgLike)).catch(() => {});
    return;
  }
  if (attackerHealth.energy === 0) {
    bot.sendMessage(chatId, `${actorLabel}, нет энергии на удар — отдохни (⚡ 1 за 20 мин).`, threadOpts(msgLike)).catch(() => {});
    return;
  }

  const attackerInjury = getUserInjury(attacker.id);
  const attackerStats = getStats(attacker.id);
  const weapon = pickWeaponForAttacker('human', attacker.id, slot, PVP_WEAPONS);
  let effectiveCooldownMs = Math.max(MIN_PVP_COOLDOWN_MS, PVP_COOLDOWN_MS * (1 - attackerStats.agility * AGILITY_COOLDOWN_PER_POINT));
  // Тапки — a physical pair swings twice as often as any other weapon,
  // clean or soiled (see WEAPON_DEFS.tapki); soiled additionally swaps
  // in the higher multiplier and flavor text right here, so every
  // downstream read (damage calc, the hit line itself) picks it up.
  if (weapon.key === 'tapki') {
    effectiveCooldownMs = Math.max(MIN_PVP_COOLDOWN_MS, effectiveCooldownMs / 2);
    if (isTapkiSoiled()) {
      weapon.multiplier = 1;
      weapon.text = 'ссаными тапками';
    }
  }
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
  if (isInTree(attacker.id)) {
    db.prepare('UPDATE user_health SET tree_until = NULL WHERE user_id = ?').run(attacker.id);
    await bot.sendMessage(chatId, `🌳 ${actorLabel} слезает с дерева, чтобы напасть!`, threadOpts(msgLike)).catch(() => {});
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

  const roll = Math.floor(Math.random() * 101);
  let success;
  let dodged = false;
  let attackerScore = null;
  let defenderScore = null;
  if (roll === 100) {
    success = true;
  } else if (roll === 0) {
    success = false;
  } else {
    attackerScore = roll + attackerStats.accuracy * ACCURACY_PER_POINT - (attackerInjury === 'head' ? HEAD_INJURY_ACCURACY_PENALTY : 0);
    const defenderRoll = Math.floor(Math.random() * 101);
    defenderScore = defenderRoll + monsterDef.stats.agility * AGILITY_DODGE_PER_POINT;
    success = attackerScore > defenderScore;
    dodged = !success;
  }

  const outcome = roll === 0 ? '❌ неудачно' : dodged ? '🌀 уворот!' : '✅ удачно';
  const scoreText = attackerScore !== null ? ` (${Math.round(attackerScore)} против ${Math.round(defenderScore)})` : '';
  await bot.sendMessage(
    chatId,
    `${actorLabel} — ударить ${goblin.name} ${weapon.text} ${outcome}: ${roll}/100${scoreText}`,
    threadOpts(msgLike)
  ).catch(() => {});
  if (!success) {
    if (roll === 0 && weapon.key) {
      if (weapon.instanceKey.startsWith('knife:')) {
        const knifeId = Number(weapon.instanceKey.slice('knife:'.length));
        db.prepare('UPDATE owned_knives SET owner_user_id = ?, owner_username = NULL, is_dropped = 1, dropped_chat_id = ? WHERE id = ?').run(attacker.id, chatId, knifeId);
      } else {
        db.prepare(
          "UPDATE weapon_ownership SET owner_type = 'dropped', owner_user_id = ?, owner_username = NULL, dropped_chat_id = ? WHERE weapon_key = ?"
        ).run(attacker.id, chatId, weapon.key);
      }
      await bot.sendMessage(
        chatId,
        `😱 ${actorLabel} так мажет, что ${WEAPON_DEFS[weapon.key].name} вылетает из рук! Кто первым напишет что-нибудь в чат — подберёт.`,
        threadOpts(msgLike)
      ).catch(() => {});
    }
    return;
  }

  combatLockouts.set(attacker.id, Date.now());

  const strengthFactor = 1 + attackerStats.strength * STRENGTH_DAMAGE_PER_POINT;
  const armInjuryFactor = attackerInjury === 'arm' ? ARM_INJURY_DAMAGE_MULT : 1;
  const healthBefore = goblin.health;
  if (roll === 100) {
    goblin.health = 0;
    await bot.sendMessage(
      chatId,
      `💯 СОКРУШИТЕЛЬНЫЙ УДАР! ${actorLabel} сносит ${goblin.name} всё здоровье разом (${healthBefore} -> 0)!`,
      threadOpts(msgLike)
    ).catch(() => {});
  } else {
    const rawDmg = Math.floor(Math.random() * 20) + 1;
    // Defense in depth on top of every WEAPON_DEFS entry now carrying a
    // multiplier: an undefined one here would silently turn into NaN
    // damage, which permanently corrupts goblin.health to NaN (immortal,
    // shows "NaN ХП" in /goblins) rather than crashing loudly — exactly
    // what happened before carrot/dildo got their fallback multiplier.
    const dmg = Math.round(rawDmg * (weapon.multiplier || 1) * strengthFactor * armInjuryFactor);
    goblin.health = Math.max(0, goblin.health - dmg);
    await bot.sendMessage(
      chatId,
      `💥 Урон ${goblin.name}: ${dmg} (${healthBefore} -> ${goblin.health})`,
      threadOpts(msgLike)
    ).catch(() => {});
  }

  const isCrit = roll >= getCritThreshold(attacker.id);
  if (isCrit) recordCrit(attacker.id);
  const xpGain = roll === 100 ? XP_PER_NAT100 : isCrit ? XP_PER_CRIT : XP_PER_HIT;
  ensureStatsRow(attacker.id);
  db.prepare('UPDATE pvp_stats SET xp = xp + ? WHERE user_id = ?').run(xpGain, attacker.id);

  if (goblin.health === 0) {
    db.prepare('UPDATE pvp_stats SET coins = coins + ? WHERE user_id = ?').run(goblin.coins, attacker.id);
    await bot.sendMessage(chatId, `💀 ${goblin.name} повержен! ${actorLabel} забирает ${goblin.coins} монет.`, threadOpts(msgLike)).catch(() => {});
    checkGoblinRaidCleared();
  } else {
    goblin.targetUserId = attacker.id;
  }
}

// /defend — voluntary 30-min self-buff trading offense for defense (see
// docs/superpowers/specs/2026-08-24-hospital-and-defend-design.md).
// Always succeeds once energy is paid (unlike the kuni buffs' 50/50 —
// this is "assume a stance," not an attempt that can fail). Cooldown is
// the stance's own duration, same pattern as kuniFun/kuniAlia/kuniTama.
bot.onText(/\/defend\b/i, (msg) => {
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
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
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
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
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
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
  if (isPvpPaused()) return bot.sendMessage(msg.chat.id, '⛔ PvP-бои сейчас приостановлены.', threadOpts(msg)).catch(() => {});
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
  // drop's chat from anyone but the dropper claims it. Runs unconditionally
  // (same reasoning as the resolution UPDATE above — a muted/fisher/molchun
  // user's message still counts as "writing something in the chat"), EXCEPT
  // while PvP is paused (see /pvpon//pvpoff) — a pause is meant to freeze
  // every PvP state change, and this ambient listener is no exception even
  // though it isn't itself a command.
  if (!isPvpPaused()) {
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
    const droppedKnivesHere = db.prepare(
      'SELECT id FROM owned_knives WHERE is_dropped = 1 AND dropped_chat_id = ? AND owner_user_id != ?'
    ).all(msg.chat.id, msg.from.id);
    for (const row of droppedKnivesHere) {
      const changed = db.prepare(
        'UPDATE owned_knives SET owner_user_id = ?, owner_username = ?, is_dropped = 0, dropped_chat_id = NULL WHERE id = ? AND is_dropped = 1 AND dropped_chat_id = ?'
      ).run(msg.from.id, msg.from.username, row.id, msg.chat.id);
      if (changed.changes > 0) {
        const def = WEAPON_DEFS.knife;
        const finderLabel = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        bot.sendMessage(msg.chat.id, `${def.emoji} ${finderLabel} находит и забирает ${def.accusative} — теперь бьёт ${def.instrumental} сам!`, threadOpts(msg)).catch(() => {});
      }
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
    // way, see muteUser/isMuted above. Reached both via a troll-bot-caused
    // knockout AND via tg-bot's own /kick when больничка couldn't be paid
    // for (see docs/superpowers/specs/2026-08-25-paid-hospital-design.md
    // and damageHuman's isKnockedOut fallback) — either source writes the
    // same 'драка' mute into this same shared table.
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
  bot.sendMessage(msg.chat.id, `chat_id: ${msg.chat.id}\nmessage_thread_id: ${msg.message_thread_id ?? '(нет — не топик)'}`, threadOpts(msg)).catch(() => {});
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
    '/wallet — узнать свой баланс монет',
    '/shop — магазин: эликсиры и ржавый нож (купить 5 монет, продать за 3); одежда скоро',
    '/restore — выпить эликсир здоровья: +100 ХП, не выше максимума',
    '/recharge — выпить эликсир энергии: полное восстановление',
    '/give @username — передать эликсир или оружие другому воину (с его подтверждением)',
    '/kick @юзернейм (или ответом) — ударить подручными средствами; /kick1, /kick2, /kick3 — конкретным оружием по номеру слота (см. /me), если в слоте пусто — тоже подручными (работает только в чате «Поединки»; нужно быть воином — и атакующему, и цели, см. /warrior; без ответного удара; урон 1-20 × сила и множитель оружия, попадание зависит от точности, после попадания жертва может увернуться (базово 50%, зависит от её ловкости); критический удар — травма на 20-180 минут (голова -10% точности, рука -10% урона, нога -10% уворота у пострадавшего — не блокирует атаку), 0 здоровья — попадает в больничку (недоступен для удара, регенерация ×2, пока не наберёт 30 ХП; может выйти раньше сам, атаковав) + если у жертвы было оружие, добивший получает кнопки забрать/оставить (при нескольких — выбор какое; сам захват — ещё 50/50, жертва может вцепиться и не отдать); тратит 1 энергию из 10, восстановление зависит от выносливости; пауза между ударами зависит от ловкости, действует отдельно на каждое оружие/на голые руки; ровно 100/100 — не увернуться, сразу сносит всю жизнь цели; ровно 0/100 с оружием в руке — роняет его, первый написавший в чат кроме тебя подбирает; удачный удар даёт опыт — см. /levelup; во время набега гоблинов (/goblinraid) им можно бить и их — см. /goblins)',
    '/hide [часы] — спрятаться в чулане от /kick на N часов (по умолчанию 1); чулан вмещает только 5 человек — если он полон, новый прячущийся случайно выкидывает оттуда кого-то одного; тратит N энергии сразу, при недостатке энергии — отказ; своя атака снимает прятки и на 20 минут блокирует повторный /hide; сама команда — раз в 20 минут',
    '/tree — залезть на дерево и спрятаться от /kick на 5 минут; доступно только текущему владельцу когтей Лимы; тратит 1 энергию, без своего кулдауна (кроме нехватки энергии); своя атака снимает и слезает с дерева',
    '/piss_tapki — доступно только текущему владельцу тапок: превращает их в ссаные тапки на 10 минут, потом сами возвращаются в обычные; тратит 1 энергию, кулдаун 20 мин',
    'Катана (см. /me) — не как обычное оружие: один /kick катаной это 3 независимых удара подряд (0.4x/0.4x/0.8x, каждый со своим шансом попасть/крит/травму) за ту же 1 энергию и тот же кулдаун; плюс пока катана у тебя в руках — 25% шанс заблокировать вообще любую атаку по тебе, даже нат-100 и даже /fuck',
    '/find — список всех бойцов: 🏥 сначала те, кто в больничке, затем 🐰 те, кто в чулане, затем 🌳 те, кто на дереве (с оставшимся временем), затем ⚔️ остальные',
    '/levelup точность|сила|ловкость|выносливость — тратит 1 очко характеристики (уровни 1-9 по 100 опыта каждый, дальше каждый следующий на 10% дороже предыдущего: 110, 121, 133...; опыт: +1 за удачный удар, +5 за крит, +15 за 100/100, +3 за успешный /fuck); сила также даёт +5 к максимуму ХП за очко, выносливость — +1 к максимуму энергии за очко',
    '/kuniFun — попытка получить бафф +50% крит на /kick, 10 мин (50% шанс успеха; тратит 2 энергии в любом случае; кулдаун = 10 мин в любом случае)',
    '/kuniAlia — попытка получить бафф +50% уклонение от /kick, 10 мин (50% шанс успеха; тратит 2 энергии в любом случае; кулдаун = 10 мин в любом случае)',
    '/kuniTama — попытка получить бафф +25% крит и +25% уклонение, 10 мин (50% шанс успеха; тратит 2 энергии в любом случае; кулдаун = 10 мин в любом случае)',
    '/defend — встать в защитную стойку на 30 мин: +25 к увороту, −40% входящего урона (только обычный урон, не нат.100/жопу морковкой); атака снимает стойку; тратит 2 энергии, кулдаун = сама стойка',
    '/box <код> — угадать 3-значный код запертого ящика (см. объявление в чате); 1 попытка в час; каждая неверная попытка показывает одну и ту же подсказку — какая по счёту цифра заклинила и чему она равна; что внутри — секрет до правильной угадки',
    '/duel @username [ставка] (или ответом) — вызвать на дуэль 1 на 1; у цели 2 минуты на /duelaccept; пока дуэль идёт — вы двое можете /kick только друг друга, никто третий не вмешается, эликсиры под запретом; конец — чья-то смерть или 5 минут (тогда побеждает тот, у кого больше HP, ровно поровну — ничья); указанную ставку монет платят оба поровну, победитель забирает весь банк (ничья — ставки возвращаются)',
    '/duelaccept — принять вызов на дуэль (см. /duel)',
    '/fuck @username (или ответом) — попытка трахнуть оппонента: 40% успех, 50% провал, 10% сам(а) не сдержался(-лась); тратит 3 энергии в любом случае; успех — +3 опыта атакующему, жертва получает оргазм и парализована на 10-40 мин (не может ни бить, ни быть избитой); провал — просто сообщение; на 10% атакующий сам(а) парализуется на 10-40 мин, жертву не трогает',
    '/goblinraid [уровень] — (админ) наслать набег вручную, по умолчанию «рейд». Уровни: разведка (2-5 гоблинов), рейд (5-10 гоблинов), атака (5-10 гоблинов + 1-2 орка), нашествие (10-20 гоблинов + 2-5 орков), тролль (см. ниже). Гоблин: 60 ХП, точность 3, уворот 5, сила 1, 20 энергии (максимум ударов), 3-10 монет. Орк: 120 ХП, точность 2, уворот 2, сила 7, выносливость 3, 35 энергии, 15-35 монет. Оба бьют раз в минуту (та же формула попадания/уворота, что и у /kick); 10% шанс, что вместо удара будет попытка /fuck (40% успеха, 10-40 мин паралича жертве). Плюс автонабеги: разведка выходит дважды в день, в случайный момент 08:00-12:00 и ещё раз 18:00-22:00 (15 минут — не зачистили, оставшиеся сбегают); ровно через 10 минут после конца каждой разведки — если зачистили, усиленная разведка ×1.5 (10 минут); если кто-то сбежал — случайно рейд (40%), атака (40%) или нашествие (20%), без ограничения по времени',
    '/goblinraid тролль (или тролленок) — (админ) отдельный одиночный босс, не смешивается с гоблинами/орками. Тролль: 1000 ХП, сила 15, регенерирует 10 ХП каждые 10 сек, бьёт сразу троих. Тролленок (слабее): 650 ХП, сила 8, регенерирует 5 ХП каждые 40 сек, бьёт сразу двоих. У обоих: точность 4, уворот 1, энергия бесконечная; бьёт раз в 30 сек (тот же 10% шанс /fuck вместо удара, что и у гоблинов); каждый 4-й удар вместо этого сносит чулан — все, кто там прятался, вылетают наружу; сбегает через 15 минут, если не убить. При нокауте — тот же 50%-шанс ограбить монеты, что у гоблина/орка (изначально 0 монет — всё, что при смерти достанется убийце, награблено за бой), плюс 50% шанс дополнительно вырвать у жертвы одно оружие (сам не пользуется — только своей дубиной; оружие падает в чат, забрать может кто угодно кроме самой жертвы)',
    '/goblins — список текущих гоблинов набега: ХП, энергия, кого бьют',
    '/kick <имя гоблина> (или ответом на его сообщение об ударе, или /kick1/2/3 конкретным оружием) — тот же /kick, что и по игрокам: та же формула попадания/уворота и урон = множитель оружия × сила, только без травм и спецэффектов оружия (у гоблинов нет ни травм, ни энергии/статусов, под которые они заточены); убийство — все его 3-10 монет твои; попадание переключает агро гоблина на тебя',
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
  // This whole handler exclusively serves PvP callback data (levelup:,
  // gv_i:, gv_y:/gv_n:, steal_coins:, shop:*, steal_yes:/steal_no:) —
  // no non-PvP feature routes through it, so one guard at the top
  // covers every branch below.
  if (isPvpPaused()) return bot.answerCallbackQuery(query.id, { text: 'PvP сейчас приостановлен', show_alert: true }).catch(() => {});

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
    const { level: currentLevel, nextThreshold } = levelInfoForXp(stats.xp);
    const available = currentLevel - (stats.accuracy + stats.strength + stats.agility + stats.endurance);
    if (available <= 0) {
      const needed = nextThreshold - stats.xp;
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
      const instanceKey = itemType.slice('weapon:'.length);
      if (instanceKey.startsWith('knife:')) {
        const knifeId = Number(instanceKey.slice('knife:'.length));
        const row = db.prepare("SELECT 1 FROM owned_knives WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(knifeId, senderId);
        available = !!row;
      } else {
        const row = db.prepare(
          "SELECT 1 FROM weapon_ownership WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
          "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
        ).get(instanceKey, senderId);
        available = !!row;
      }
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
      const instanceKey = itemType.slice('weapon:'.length);
      if (instanceKey.startsWith('knife:')) {
        const knifeId = Number(instanceKey.slice('knife:'.length));
        const result = db.prepare(
          "UPDATE owned_knives SET owner_user_id = ?, owner_username = ? WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')"
        ).run(targetId, query.from.username, knifeId, senderId);
        transferred = result.changes > 0;
      } else {
        const result = db.prepare(
          "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? " +
          "WHERE weapon_key = ? AND owner_type = 'human' AND owner_user_id = ? " +
          "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
        ).run(targetId, query.from.username, instanceKey, senderId);
        transferred = result.changes > 0;
      }
    }

    if (!transferred) {
      await bot.editMessageText('У отправителя этого уже нет.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    await bot.editMessageText(`✅ ${senderLabel} передал(а) ${itemLabel(itemType)} игроку ${targetLabel}!`, editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  // Wallet-robbery option on the knockout-loot offer (see
  // docs/superpowers/specs/2026-08-25-wallet-design.md). Coins are
  // fungible — unlike weapon ownership, which is a unique resource a
  // second click naturally can't re-steal — so this needs an explicit
  // double-click guard (the steal_yes:/steal_no: branch below shares
  // this same guard too, so "one action per knockout" — weapon, wallet,
  // or decline — actually holds across all three, not just this one).
  // Reuses /give's existing resolvedGiveOffers Set rather than
  // introducing a second near-identical one — safe because the dedup
  // key is chatId:messageId, and Telegram message_ids are never reused
  // within a chat, so a /give offer and a knockout-loot offer can never
  // collide regardless of which feature's callback_data prefix is on
  // the button actually clicked.
  if (data.startsWith('steal_coins:')) {
    const [, attackerIdStr, victimIdStr] = data.split(':');
    const attackerId = Number(attackerIdStr);
    if (query.from.id !== attackerId) {
      return bot.answerCallbackQuery(query.id, { text: 'Это не твой трофей', show_alert: true }).catch(() => {});
    }

    const victimId = Number(victimIdStr);
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const editOpts = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };

    const resolvedKey = `${chatId}:${messageId}`;
    if (resolvedGiveOffers.has(resolvedKey)) {
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }
    resolvedGiveOffers.add(resolvedKey);
    if (resolvedGiveOffers.size > MAX_RESOLVED_GIVE_OFFERS) resolvedGiveOffers.delete(resolvedGiveOffers.values().next().value);

    const row = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(victimId);
    const currentCoins = row ? row.coins : 0;
    if (currentCoins <= 0) {
      await bot.editMessageText('Кошелёк уже пуст — кто-то опередил.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;

    // Same 50/50 grip roll as the weapon-steal branch below — the downed
    // victim gets one last chance to hang on to their money too.
    if (Math.random() < 0.5) {
      const known = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(victimId);
      const victimLabel = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${victimId}`;
      await bot.editMessageText(`🤜 ${actorLabel} пытается обшарить карманы, но ${victimLabel} вцепляется в кошелёк мёртвой хваткой — не отдаёт!`, editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    const amount = Math.floor(Math.random() * currentCoins) + 1;
    db.prepare('UPDATE pvp_stats SET coins = coins - ? WHERE user_id = ?').run(amount, victimId);
    // ensureStatsRow before crediting — same defensive precedent /give's
    // gv_y branch follows, so a credit never silently no-ops if the
    // attacker somehow lacks a pvp_stats row (today that can't happen,
    // since reaching performKick already requires isWarrior(attacker.id),
    // which itself requires the row to exist — but don't rely on that
    // invariant staying true forever without a guard here too).
    ensureStatsRow(query.from.id);
    db.prepare('UPDATE pvp_stats SET coins = coins + ? WHERE user_id = ?').run(amount, query.from.id);
    await bot.editMessageText(`🪙 ${actorLabel} обшарил(а) карманы отключившегося и стащил(а) ${amount} монет!`, editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  // /shop — see docs/superpowers/specs/2026-08-25-shop-elixirs-design.md.
  // Self-service, same idiom as levelup: above — acts on whoever
  // clicked (query.from.id), not whoever originally ran /shop, since
  // every user has their own independent pvp_stats row and there's
  // nothing to authorize against. Message stays editable with a fresh
  // keyboard, so repeated purchases don't need re-running the command.
  if (data === 'shop:soon') {
    return bot.answerCallbackQuery(query.id, { text: 'Скоро!', show_alert: true }).catch(() => {});
  }
  if (data === 'shop:back') {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    await bot.editMessageText(`🏪 ${actorLabel}, магазин:`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: shopCategoryKeyboard(),
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  if (data === 'shop:elixirs') {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    ensureStatsRow(query.from.id);
    const stats = db.prepare('SELECT coins, health_elixirs, energy_elixirs FROM pvp_stats WHERE user_id = ?').get(query.from.id);
    await bot.editMessageText(elixirShopText(actorLabel, stats), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: elixirShopKeyboard(),
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  if (data === 'shop:weapons') {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    ensureStatsRow(query.from.id);
    const coinsRow = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(query.from.id);
    const knifeCount = db.prepare("SELECT COUNT(*) AS n FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(query.from.id).n;
    await bot.editMessageText(weaponShopText(actorLabel, coinsRow.coins, knifeCount), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: weaponShopKeyboard(),
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  if (data.startsWith('shop:buy:') || data.startsWith('shop:sell:')) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const actorLabel = query.from.username ? `@${query.from.username}` : query.from.first_name;
    const userId = query.from.id;
    ensureStatsRow(userId);

    let ok = false;
    if (data === 'shop:buy:health') {
      ok = !!db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
      if (ok) db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs + 1 WHERE user_id = ?').run(userId);
    } else if (data === 'shop:buy:energy') {
      ok = !!db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
      if (ok) db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs + 1 WHERE user_id = ?').run(userId);
    } else if (data === 'shop:sell:health') {
      ok = !!db.prepare('UPDATE pvp_stats SET health_elixirs = health_elixirs - 1 WHERE user_id = ? AND health_elixirs >= 1 RETURNING health_elixirs').get(userId);
      if (ok) db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
    } else if (data === 'shop:sell:energy') {
      ok = !!db.prepare('UPDATE pvp_stats SET energy_elixirs = energy_elixirs - 1 WHERE user_id = ? AND energy_elixirs >= 1 RETURNING energy_elixirs').get(userId);
      if (ok) db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
    } else if (data === 'shop:buy:knife') {
      ok = !!db.prepare('UPDATE pvp_stats SET coins = coins - 5 WHERE user_id = ? AND coins >= 5 RETURNING coins').get(userId);
      if (ok) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO owned_knives (owner_user_id, owner_username, is_dropped, dropped_chat_id, acquired_at, expires_at) VALUES (?, ?, 0, NULL, ?, ?)')
          .run(userId, query.from.username, now, now + 3 * 3600);
      }
    } else if (data === 'shop:sell:knife') {
      // ORDER BY id ASC — a deliberate, deterministic tie-break: selling
      // when the player holds several knives always gives up the OLDEST
      // one (soonest to decay anyway), not an arbitrary one.
      const oldest = db.prepare("SELECT id FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now') ORDER BY id LIMIT 1").get(userId);
      ok = !!oldest;
      if (ok) {
        db.prepare('DELETE FROM owned_knives WHERE id = ?').run(oldest.id);
        db.prepare('UPDATE pvp_stats SET coins = coins + 3 WHERE user_id = ?').run(userId);
      }
    }

    if (!ok) {
      const failText = data.startsWith('shop:buy:') ? 'Не хватает монет' : 'Нечего продать';
      return bot.answerCallbackQuery(query.id, { text: failText, show_alert: true }).catch(() => {});
    }

    const isWeaponAction = data === 'shop:buy:knife' || data === 'shop:sell:knife';
    if (isWeaponAction) {
      const coinsRow = db.prepare('SELECT coins FROM pvp_stats WHERE user_id = ?').get(userId);
      const knifeCount = db.prepare("SELECT COUNT(*) AS n FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(userId).n;
      await bot.editMessageText(weaponShopText(actorLabel, coinsRow.coins, knifeCount), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: weaponShopKeyboard(),
      }).catch(() => {});
    } else {
      const stats = db.prepare('SELECT coins, health_elixirs, energy_elixirs FROM pvp_stats WHERE user_id = ?').get(userId);
      await bot.editMessageText(elixirShopText(actorLabel, stats), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: elixirShopKeyboard(),
      }).catch(() => {});
    }
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  if (!data.startsWith('steal_yes:') && !data.startsWith('steal_no:')) return;

  // instanceKey may itself contain a colon ("knife:17") — reconstruct it
  // from every part after the first three, same colon-safe idiom /give
  // already uses for its own itemType, rather than a naive fixed-count
  // positional destructure that would truncate a knife's id.
  const [action, attackerIdStr, victimIdStr, ...instanceKeyParts] = data.split(':');
  const instanceKey = instanceKeyParts.join(':');
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

  // Same guard steal_coins: uses below, shared across this whole offer
  // message — without it, tapping a weapon button and the wallet button
  // in quick succession (before editMessageText's round-trip visibly
  // disables the sibling buttons) could walk away with both, instead of
  // "one action per knockout" actually being enforced.
  const resolvedKey = `${chatId}:${messageId}`;
  if (resolvedGiveOffers.has(resolvedKey)) {
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }
  resolvedGiveOffers.add(resolvedKey);
  if (resolvedGiveOffers.size > MAX_RESOLVED_GIVE_OFFERS) resolvedGiveOffers.delete(resolvedGiveOffers.values().next().value);

  if (action === 'steal_no') {
    await bot.editMessageText('Оружие оставлено — трофей не забран.', editOpts).catch(() => {});
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  // instanceKey pins down exactly which button was pressed — re-verify
  // live that it's still on the victim (not moved by a different button
  // click in the meantime) rather than trusting the offer's snapshot.
  // Same expiry filter as getWeaponsFor — without it, an expired knife
  // could still be "stolen" here despite already being invisible
  // everywhere else (getWeaponsFor, /me, /find, /warriors).
  const victimId = Number(victimIdStr);
  let weaponKey;
  if (instanceKey.startsWith('knife:')) {
    const knifeId = Number(instanceKey.slice('knife:'.length));
    const knifeRow = db.prepare("SELECT id FROM owned_knives WHERE id = ? AND owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')").get(knifeId, victimId);
    if (!knifeRow) {
      await bot.editMessageText('Этого оружия там уже нет — кто-то опередил.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }
    weaponKey = 'knife';
  } else {
    const row = db.prepare(
      "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? AND weapon_key = ? " +
      "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
    ).get(victimId, instanceKey);
    if (!row) {
      await bot.editMessageText('Этого оружия там уже нет — кто-то опередил.', editOpts).catch(() => {});
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }
    weaponKey = row.weapon_key;
  }

  const def = WEAPON_DEFS[weaponKey];
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

  if (instanceKey.startsWith('knife:')) {
    const knifeId = Number(instanceKey.slice('knife:'.length));
    db.prepare('UPDATE owned_knives SET owner_user_id = ?, owner_username = ? WHERE id = ?').run(query.from.id, query.from.username, knifeId);
  } else {
    db.prepare(
      "UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?"
    ).run(query.from.id, query.from.username, weaponKey);
  }
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
// Energy regens on its own fixed cadence (1 point per 10 minutes, no
// proration) rather than health's per-hour rate — simpler since 1 is
// already the smallest unit, so partial-interval gains would always be 0
// anyway.
const ENERGY_REGEN_INTERVAL_SECONDS = 10 * 60;

function healthRegenTick() {
  if (isPvpPaused()) return;
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
    const regenState = db.prepare('SELECT last_full_restore_date, last_daily_payout_date FROM health_regen_state WHERE id = 1').get();
    const hour = new Date().getHours();
    if (hour === 4 && regenState.last_full_restore_date !== today) {
      db.prepare('UPDATE user_health SET health = max_health, last_regen_at = ?, hospitalized_since = NULL WHERE health < max_health').run(now);
      db.prepare('UPDATE health_regen_state SET last_full_restore_date = ? WHERE id = 1').run(today);
    }
    if (hour === 8 && regenState.last_daily_payout_date !== today) {
      db.exec('UPDATE pvp_stats SET coins = coins + 10 WHERE is_warrior = 1');
      db.prepare('UPDATE health_regen_state SET last_daily_payout_date = ? WHERE id = 1').run(today);
      bot.sendMessage(ARENA_CHAT_ID, '💰 Всем воинам начислено +10 монет за день!', { message_thread_id: ARENA_TOPIC_ID }).catch(err => console.error('daily payout announcement failed:', err.message));
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
  if (isPvpPaused()) return;
  try {
    const now = Math.floor(Date.now() / 1000);

    // Knife decay — checked every tick regardless of whether a new drop
    // fires this time, since each knife's 3h timer runs independently of
    // both the drop schedule and every other knife (it started whenever
    // THAT knife was acquired, not when any crate wave landed). Only
    // is_dropped = 0 knives decay — same "expiry effectively pauses while
    // fumble-dropped and unclaimed" quirk the old singleton-knife code
    // already had (it only ever checked owner_type = 'human'), carried
    // over unchanged rather than "fixed" as part of this refactor.
    const expiredKnives = db.prepare("SELECT id, owner_user_id FROM owned_knives WHERE is_dropped = 0 AND expires_at < ?").all(now);
    const deleteKnife = db.prepare('DELETE FROM owned_knives WHERE id = ?');
    const getKnownUser = db.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?');
    for (const knifeRow of expiredKnives) {
      deleteKnife.run(knifeRow.id);
      const known = getKnownUser.get(knifeRow.owner_user_id);
      const label = known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${knifeRow.owner_user_id}`;
      bot.sendMessage(ARENA_CHAT_ID, `🔪💨 Ржавый нож у ${label} рассыпался от старости!`, { message_thread_id: ARENA_TOPIC_ID }).catch(() => {});
    }

    if (isArenaNightHour()) return;
    const state = db.prepare('SELECT last_drop_at, current_batch_id FROM arena_drop_state WHERE id = 1').get();
    const lastDropAt = state.last_drop_at || 0;
    if ((now - lastDropAt) * 1000 < ARENA_DROP_INTERVAL_MS) return;

    const newBatchId = state.current_batch_id + 1;
    // No more scarcity gate needed — knives are no longer a shared
    // singleton (see docs/superpowers/specs/2026-08-25-knife-multi-
    // instance-design.md), so every batch always includes one.
    const crateTypes = ['health_elixir', 'health_elixir', 'energy_elixir', 'energy_elixir', 'knife'];
    const insertCrate = db.prepare('INSERT INTO arena_crates (batch_id, crate_type, claimed_by) VALUES (?, ?, NULL)');
    const insertBatch = db.transaction((types) => {
      for (const type of types) insertCrate.run(newBatchId, type);
    });
    insertBatch(crateTypes);
    db.prepare('UPDATE arena_drop_state SET last_drop_at = ?, current_batch_id = ? WHERE id = 1').run(now, newBatchId);

    bot.sendMessage(
      ARENA_CHAT_ID,
      '📦☄️ С неба на арену упало 5 ящиков! Внутри: 2 эликсира здоровья, 2 эликсира энергии и ржавый нож. Кто первый напишет /pick — тот и заберёт (только 1 ящик в одни руки).',
      { message_thread_id: ARENA_TOPIC_ID }
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

// Auto raid schedule: a "разведка" fires twice a day — once at a random
// moment within 08:00-12:00 (morning) and again within 18:00-22:00
// (evening) — each standing for GOBLIN_RECON_DURATION_MS; any monster
// still alive when that runs out flees (see endGoblinRaidByFlee), no
// loot, raid just ends. Exactly RAID_FOLLOWUP_DELAY_MS after EACH recon
// concludes (cleared or fled — see checkGoblinRaidCleared/
// endGoblinRaidByFlee), scheduleReconFollowUp below fires the follow-up:
// fully cleared -> a reinforced "усиленная разведка" (×1.5 the goblin
// count, a bit less time); not cleared (someone fled) -> a weighted-random
// escalation (see pickFledFollowUpTier) instead of always a plain "рейд",
// so orcs (only in 'атака'/'нашествие') actually show up sometimes
// without needing an admin to type /goblinraid by hand.
// Each recon window fires at most once per calendar day (tracked in
// bot_settings so a restart mid-window can't refire something that
// already happened), and never overlaps an already-running raid — manual
// or scheduled — since scheduledRaidTick just skips its check entirely
// while goblinRaid is set, and tries again on the next tick. The
// follow-up's own 10-minute timer applies the same guard at fire time
// (see scheduleReconFollowUp) rather than retrying — if something else
// is running right at that moment, the follow-up is simply skipped.
// The exact firing moment inside each recon window uses the standard
// "reservoir" trick: every tick's fire probability is
// 1/remaining-ticks-in-window, so across the whole window the actual
// moment ends up uniformly distributed without ever precomputing or
// persisting a target time (and it's guaranteed to fire by the window's
// last tick if it hasn't already).
const RAID_SCHEDULE_TICK_MS = 5 * 60 * 1000;
const GOBLIN_RECON_DURATION_MS = 15 * 60 * 1000;
const REINFORCED_RECON_DURATION_MS = 10 * 60 * 1000;
const RAID_FOLLOWUP_DELAY_MS = 10 * 60 * 1000;

// Weighted escalation for a recon that ended in someone fleeing — 40%
// рейд (no orcs), 40% атака (1-2 orcs), 20% нашествие (2-5 orcs). Plain
// cumulative-threshold roll, same idiom as the fuck/goblin-attempt checks
// elsewhere in this file.
function pickFledFollowUpTier() {
  const roll = Math.random();
  if (roll < 0.4) return 'рейд';
  if (roll < 0.8) return 'атака';
  return 'нашествие';
}

function localDateString(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Same shape as /goblinraid's own spawn logic, just parametrized by
// already-resolved counts/duration/label instead of a RAID_TIERS lookup
// — shared by both the plain morning recon and the afternoon's two
// possible follow-ups. durationMs is optional (null = no flee timer,
// same as every manually-started raid).
function launchScheduledRaid(chatId, threadId, label, goblinCount, orcCount, durationMs, autoKind) {
  const goblins = new Map();
  for (let i = 0; i < goblinCount; i++) {
    const m = spawnMonster('goblin', i);
    goblins.set(m.id, m);
  }
  for (let i = 0; i < orcCount; i++) {
    const m = spawnMonster('orc', i);
    goblins.set(m.id, m);
  }
  goblinRaid = {
    goblins,
    chatId,
    threadId,
    tickTimer: setInterval(goblinTick, GOBLIN_ATTACK_INTERVAL_MS),
    fleeTimer: durationMs ? setTimeout(endGoblinRaidByFlee, durationMs) : null,
    autoKind,
  };
  const roster = [...goblins.values()].map((m) => `${MONSTER_TYPES[m.type].emoji} ${m.name} (${m.maxHealth} ХП)`).join('\n');
  const summary = orcCount > 0 ? `${goblinCount} гоблинов и ${orcCount} орков` : `${goblinCount} гоблинов`;
  bot.sendMessage(
    chatId,
    `👹 ${label}! На чат напало: ${summary}:\n${roster}\n\nБей их через /kick <имя> (или ответом на сообщение об их ударе). У каждого монеты — забираешь всё при убийстве.`,
    threadId ? { message_thread_id: threadId } : {}
  ).catch(() => {});
}

// Fires RAID_FOLLOWUP_DELAY_MS after a scheduled recon concludes (see
// checkGoblinRaidCleared/endGoblinRaidByFlee) — 'cleared' escalates to a
// reinforced recon, 'fled' rolls pickFledFollowUpTier's weighted tier.
// Skips silently (no retry) if PvP is paused or another raid is already
// running by the time the timer fires — same "never overlap" rule as
// scheduledRaidTick's own guard, just checked once at fire time instead
// of on a recurring tick.
function scheduleReconFollowUp(outcome, chatId, threadId) {
  setTimeout(() => {
    if (isPvpPaused() || goblinRaid) return;
    if (outcome === 'cleared') {
      const baseCount = randIntInclusive(RAID_TIERS['разведка'].goblins[0], RAID_TIERS['разведка'].goblins[1]);
      const goblinCount = Math.round(baseCount * 1.5);
      launchScheduledRaid(chatId, threadId, 'Усиленная разведка', goblinCount, 0, REINFORCED_RECON_DURATION_MS, 'auto-followup');
    } else {
      const tierName = pickFledFollowUpTier();
      const tier = RAID_TIERS[tierName];
      const goblinCount = randIntInclusive(tier.goblins[0], tier.goblins[1]);
      const orcCount = randIntInclusive(tier.orcs[0], tier.orcs[1]);
      const label = tierName.charAt(0).toUpperCase() + tierName.slice(1);
      launchScheduledRaid(chatId, threadId, label, goblinCount, orcCount, null, 'auto-followup');
    }
  }, RAID_FOLLOWUP_DELAY_MS);
}

function scheduledRaidTick() {
  if (isPvpPaused() || goblinRaid) return;
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const today = localDateString(now);

  if (hour >= 8 && hour < 12) {
    const lastDate = db.prepare("SELECT value FROM bot_settings WHERE key = 'goblin_recon_last_date'").get();
    if (!lastDate || lastDate.value !== today) {
      const remainingMinutes = 12 * 60 - (hour * 60 + minute);
      const remainingTicks = Math.max(1, Math.ceil(remainingMinutes / (RAID_SCHEDULE_TICK_MS / 60000)));
      if (Math.random() < 1 / remainingTicks) {
        db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('goblin_recon_last_date', ?)").run(today);
        const goblinCount = randIntInclusive(RAID_TIERS['разведка'].goblins[0], RAID_TIERS['разведка'].goblins[1]);
        launchScheduledRaid(ARENA_CHAT_ID, ARENA_TOPIC_ID, 'Утренняя разведка', goblinCount, 0, GOBLIN_RECON_DURATION_MS, 'morning-recon');
      }
    }
  } else if (hour >= 18 && hour < 22) {
    const lastDate = db.prepare("SELECT value FROM bot_settings WHERE key = 'goblin_recon_evening_last_date'").get();
    if (!lastDate || lastDate.value !== today) {
      const remainingMinutes = 22 * 60 - (hour * 60 + minute);
      const remainingTicks = Math.max(1, Math.ceil(remainingMinutes / (RAID_SCHEDULE_TICK_MS / 60000)));
      if (Math.random() < 1 / remainingTicks) {
        db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('goblin_recon_evening_last_date', ?)").run(today);
        const goblinCount = randIntInclusive(RAID_TIERS['разведка'].goblins[0], RAID_TIERS['разведка'].goblins[1]);
        launchScheduledRaid(ARENA_CHAT_ID, ARENA_TOPIC_ID, 'Вечерняя разведка', goblinCount, 0, GOBLIN_RECON_DURATION_MS, 'evening-recon');
      }
    }
  }
}
setInterval(scheduledRaidTick, RAID_SCHEDULE_TICK_MS);

// One-time "welcome the orcs" invasion for this deploy — fires once, 5
// minutes after the first boot following this deploy, never again after
// that (even across later restarts), same runOnce+delayed-setTimeout
// idiom as the /box drop announcement above. Skips silently if a raid is
// somehow already running by the time the timer fires.
runOnce('2026-09-01-orc-invasion-launch', () => {
  setTimeout(() => {
    if (isPvpPaused() || goblinRaid) return;
    const tier = RAID_TIERS['нашествие'];
    const goblinCount = randIntInclusive(tier.goblins[0], tier.goblins[1]);
    const orcCount = randIntInclusive(tier.orcs[0], tier.orcs[1]);
    launchScheduledRaid(ARENA_CHAT_ID, ARENA_TOPIC_ID, 'Нашествие', goblinCount, orcCount, null, 'deploy-invasion');
  }, 5 * 60 * 1000);
});

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
  if (isPvpPaused()) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare('SELECT user_id, health, bleed_until, bleed_chat_id, last_bleed_stop_attempt_at FROM user_health WHERE bleed_until IS NOT NULL').all();
    for (const row of rows) {
      // bleed_chat_id is always ARENA_CHAT_ID (applyBleed is only ever
      // called from performKick, already gated to that chat) — but it's
      // the group's chat_id, not "Поединки" the topic, so every message
      // here still needs message_thread_id spelled out explicitly.
      const label = labelForUserId(row.user_id);
      if (row.bleed_until <= now) {
        db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(row.user_id);
        bot.sendMessage(row.bleed_chat_id, `🩸 Кровотечение у ${label} остановилось само.`, { message_thread_id: ARENA_TOPIC_ID }).catch(() => {});
        continue;
      }
      if (row.health === 0) continue;
      const before = row.health;
      const after = damageHuman(row.user_id, row.bleed_chat_id, null, 1);
      bot.sendMessage(row.bleed_chat_id, `🩸 Кровотечение у ${label}: -1 хп (${before} -> ${after})`, { message_thread_id: ARENA_TOPIC_ID }).catch(() => {});
      if (!row.last_bleed_stop_attempt_at || now - row.last_bleed_stop_attempt_at >= BLEED_STOP_ROLL_INTERVAL_SECONDS) {
        if (Math.random() < 0.5) {
          db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL, last_bleed_stop_attempt_at = ? WHERE user_id = ?').run(now, row.user_id);
          bot.sendMessage(row.bleed_chat_id, `🩸 Кровотечение у ${label} остановилось.`, { message_thread_id: ARENA_TOPIC_ID }).catch(() => {});
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
