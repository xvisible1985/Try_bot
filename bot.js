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
// Migrate existing pigs to animals table
db.exec(`
  INSERT OR IGNORE INTO animals (user_id, chat_id, username, animal, added_by, added_by_name, created_at)
  SELECT user_id, chat_id, username, 'pig', added_by, added_by_name, created_at FROM pigs
`);
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

// --- Filter muted & animal messages ---
bot.on('message', async (msg) => {
  if (msg.from?.is_bot) return;
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
    // way, see muteUser/isMuted above.
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
  const dimonRow = db.prepare('SELECT message_count FROM dimoniacs WHERE user_id = ?').get(msg.from.id);
  if (dimonRow && msg.text && !msg.text.startsWith('/') && !msg.text.startsWith('**')) {
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
        const aRow = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(msg.from.id);
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
  const animalRow = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(msg.from.id);
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

// --- Help ---
bot.onText(/\/help\b/, (msg) => {
  const text = [
    'Команды бота (только для админов)',
    '',
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
    '',
    'Мут:',
    '/mute [10m|2h|1d] — замутить (ответ на сообщение)',
    '/unmute — размутить',
    '/mutes — список замутов',
    '',
    'Прочее:',
    '/animals — список всех активных статусов',
    '/names — список администраторов',
    '/try [текст] — попытка (0–100)',
    '/dice [максимум] — кубик',
    '** [текст] — действие от третьего лица',
    '',
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
  bot.sendMessage(msg.chat.id, text, threadOpts(msg));
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

bot.on('polling_error', (err) => console.error('polling_error:', err.message));
bot.on('message', (msg) => console.log('сообщение от:', msg.from?.username, 'текст:', msg.text));
console.log('Бот запущен...');
