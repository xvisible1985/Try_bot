const crypto = require('crypto');

// Telegram's documented check: https://core.telegram.org/widgets/login#checking-authorization
// 1. Drop the `hash` field itself from the data.
// 2. Sort every remaining field alphabetically by key, join as "key=value"
//    lines with "\n" — this is the "data-check-string".
// 3. secret_key = SHA256(bot_token) — raw bytes, not hex.
// 4. computed_hash = HMAC-SHA256(data-check-string, secret_key), hex.
// 5. Reject unless computed_hash === received hash (constant-time compare)
//    AND auth_date is recent (Telegram doesn't expire these itself — an
//    old, replayed callback URL would otherwise verify forever).
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

function verifyTelegramLogin(data, botToken) {
  const { hash, ...fields } = data;
  if (!hash || typeof hash !== 'string') return false;

  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  const receivedBuffer = Buffer.from(hash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');
  if (receivedBuffer.length !== computedBuffer.length) return false;
  if (!crypto.timingSafeEqual(receivedBuffer, computedBuffer)) return false;

  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate)) return false;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS || ageSeconds < -60) return false;

  return true;
}

module.exports = { verifyTelegramLogin };
