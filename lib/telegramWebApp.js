const crypto = require('crypto');

// Telegram Mini App initData check: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Structurally similar to the Login Widget's check (lib/telegramAuth.js,
// removed later in this plan) but NOT the same algorithm — do not
// "simplify" this back to that file's pattern:
// 1. Drop `hash`, sort remaining fields alphabetically, join "key=value"
//    lines with "\n" — same data-check-string idea as the Login Widget.
// 2. secret_key = HMAC-SHA256(key: the literal string "WebAppData",
//    message: bot_token) — an HMAC, not a plain SHA256 hash of the
//    token. This is the one detail most likely to get copy-pasted wrong
//    from the Login Widget's `crypto.createHash('sha256').update(...)`.
// 3. computed_hash = HMAC-SHA256(secret_key, data-check-string), hex.
// 4. Reject unless computed_hash === received hash (constant-time) AND
//    auth_date is recent — 1 hour here, tighter than the Login Widget's
//    24h, since Telegram regenerates initData fresh every time the Mini
//    App is opened; there's no reason for a legitimate one to be old.
// 5. On success, the `user` field is itself a JSON string — parse it and
//    return its numeric `id`. Never throws: every failure path (bad
//    signature, stale date, missing/malformed `user`) returns null so
//    callers can use it directly without a try/catch.
const MAX_AUTH_AGE_SECONDS = 60 * 60;

function verifyWebAppInitData(initData, botToken) {
  if (typeof initData !== 'string' || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const fields = [];
  for (const key of Array.from(params.keys()).sort()) {
    fields.push(`${key}=${params.get(key)}`);
  }
  const checkString = fields.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  const receivedBuffer = Buffer.from(hash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');
  if (receivedBuffer.length !== computedBuffer.length) return null;
  if (!crypto.timingSafeEqual(receivedBuffer, computedBuffer)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS || ageSeconds < -60) return null;

  try {
    const user = JSON.parse(params.get('user'));
    if (!user || !Number.isFinite(Number(user.id))) return null;
    return Number(user.id);
  } catch {
    return null;
  }
}

module.exports = { verifyWebAppInitData };
