require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const Database = require('better-sqlite3');

const token = process.env.BOT_TOKEN;
const proxy = process.env.PROXY_URL;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
const bot = new TelegramBot(token, { request: { agent } });

// --- SQLite ---
const db = new Database('mutes.db');
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
  CREATE TABLE IF NOT EXISTS ramzans (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    added_by INTEGER,
    added_by_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);

// --- Animal definitions ---
const ANIMALS = {
  pig:    { emoji: '🐷', sound: 'Хрю-хрю' },
  cat:    { emoji: '🐱', sound: 'Мяяяяяууу' },
  fox:    { emoji: '🦊', sound: 'Фыр-фыр-фыр' },
  dog:    { emoji: '🐶', sound: 'Гав-гав' },
  cow:    { emoji: '🐄', sound: 'Мууууууу' },
  donkey: { emoji: '🫏', sound: 'Иа-ииа' },
};

// --- Profanity filter ---
const BAD_WORDS = [
  'блять','бля','блядь','сука','хуй','пизд','ебат','ебан','ебать',
  'нахуй','пиздец','заеб','уеб','отъеб','выеб','разъеб','приеб',
  'долбоёб','долбоеб','ёбан','еблан','пидор','пидар','мудак','мудила',
  'шлюх','дерьм','говн','жоп','хер','залуп','ёпт','ёб',
  'сукa','бляядь','бляяя','пиздa'
];

// fuzzy: allow repeated chars and common substitutions (а/@, о/0, е/3, и/4, etc.)
function fuzzyPattern(word) {
  const subs = {
    'а': '[а@4a]', 'о': '[о0o]', 'е': '[еe3ё]', 'и': '[иu4]',
    'с': '[сc]', 'р': '[рp]', 'к': '[кk]', 'х': '[хx]',
    'в': '[вb]', 'м': '[мm]', 'т': '[тt]', 'н': '[нh]',
    'з': '[з3]', 'д': '[д]', 'я': '[я]', 'ю': '[ю]',
    'у': '[уy]', 'г': '[гr]', 'л': '[л]', 'п': '[п]',
    'б': '[б6]', 'ж': '[ж]', 'ф': '[ф]', 'ч': '[ч]',
    'ш': '[ш]', 'щ': '[щ]', 'ц': '[ц]', 'ъ': '[ъ]',
    'ь': '[ь]', 'ы': '[ы]', 'э': '[э]',
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
  let result = text;
  let replaced = false;
  // Replace words containing special chars between letters (e.g. х*й, п@зда), ignore hyphen (кое-как)
  const specialInWord = /\S*[а-яёА-ЯЁa-zA-Z][^а-яёА-ЯЁa-zA-Z0-9\s\-][а-яёА-ЯЁa-zA-Z]\S*/g;
  result = result.replace(specialInWord, () => { replaced = true; return replacement; });
  for (const word of BAD_WORDS) {
    const re = new RegExp(fuzzyPattern(word), 'gi');
    if (re.test(result)) {
      result = result.replace(re, () => { replaced = true; return replacement; });
    }
  }
  return { text: result, replaced };
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
    const updates = await Promise.race([
      bot.getUpdates(params),
      new Promise((_, reject) => setTimeout(() => reject(new Error('poll timeout')), 5000))
    ]);
    for (const update of updates) {
      offset = update.update_id + 1;
      bot.processUpdate(update);
    }
  } catch (err) {
    if (err.message !== 'poll timeout') console.error('poll error:', err.message);
  }
  setTimeout(poll, 1000);
}
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
    db.prepare(
      'INSERT OR REPLACE INTO animals (user_id, chat_id, username, animal, added_by, added_by_name) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, msg.chat.id, user.username, animalType, msg.from.id, byName);

    bot.sendMessage(msg.chat.id, `${user.username} теперь ${emoji}`, threadOpts(msg));
  });

  bot.onText(new RegExp(`^\\/un${animalType}\\b`, 'i'), async (msg) => {
    if (!await isAdmin(msg)) return;
    const user = await resolveUser(msg);
    if (!user) return bot.sendMessage(msg.chat.id, 'Ответь на сообщение', threadOpts(msg));

    db.prepare('DELETE FROM animals WHERE user_id = ?').run(user.id);
    bot.sendMessage(msg.chat.id, `${user.username} больше не ${emoji}`, threadOpts(msg));
  });
}

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

// --- List animals ---
bot.onText(/\/animals/, (msg) => {
  const rows = db.prepare('SELECT user_id, username, animal, added_by_name FROM animals ORDER BY animal, created_at DESC').all();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Список пуст', threadOpts(msg));
  const lines = rows.map(r => `${ANIMALS[r.animal]?.emoji || '?'} ${r.username || r.user_id} (от ${r.added_by_name})`);
  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg));
});

// --- Filter muted & animal messages ---
bot.on('message', async (msg) => {
  if (msg.from?.is_bot) return;
  if (isMuted(msg.from.id)) {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    const row = db.prepare('SELECT expires_at FROM mutes WHERE user_id = ?').get(msg.from.id);
    const until = row ? formatExpire(row.expires_at) : '';
    bot.sendMessage(msg.chat.id, `${msg.from.first_name}, вы замучены ${until}`, threadOpts(msg)).catch(() => {});
    return;
  }
  const animalRow = db.prepare('SELECT animal FROM animals WHERE user_id = ?').get(msg.from.id);
  const ramzan = db.prepare('SELECT 1 FROM ramzans WHERE user_id = ?').get(msg.from.id);
  if ((animalRow || ramzan) && msg.text) {
    let text = msg.text;
    let modified = false;
    let prefix = '';

    if (animalRow) {
      const { emoji, sound } = ANIMALS[animalRow.animal] || ANIMALS.pig;
      const filtered = filterProfanity(text, sound);
      if (filtered.replaced) {
        text = filtered.text;
        modified = true;
        prefix = `${emoji} `;
      }
    }

    if (ramzan) {
      text = applyRamzan(text);
      modified = true;
    }

    if (modified) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      const nick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      bot.sendMessage(msg.chat.id, `${prefix}${nick}: ${text}`, threadOpts(msg)).catch(() => {});
    }
  }
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
  bot.sendMessage(msg.chat.id, `${username} 🟣 <b><i>${text}</i></b>`, threadOpts(msg, { parse_mode: 'HTML', ...(replyTo ? { reply_to_message_id: replyTo } : {}) }));
});

bot.on('polling_error', (err) => console.error('polling_error:', err.message));
bot.on('message', (msg) => console.log('сообщение от:', msg.from?.username, 'текст:', msg.text));
console.log('Бот запущен...');
