require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');

const token = process.env.BOT_TOKEN;
const proxy = process.env.PROXY_URL;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
const bot = new TelegramBot(token, { request: { agent } });

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

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'привет я бот');
});

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
