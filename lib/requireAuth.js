// Covers two genuinely different situations with one message, on
// purpose: (1) opened outside Telegram entirely (no initData was ever
// sent), and (2) opened via the bot but the automatic /tma/auth call
// failed silently (network hiccup, clock skew) — the bootstrap script
// in views/layout.js only logs that case to devtools, which a real user
// never sees. "Close and reopen" is the right actionable fix for BOTH:
// it either gets them into Telegram (1) or generates a fresh initData
// or a retry (2). Don't narrow this to "you're not in Telegram" — for
// case (2) that would be actively wrong, since they already are.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(403).send('Не удалось войти автоматически. Закрой и снова открой приложение через кнопку в Telegram-боте.');
  }
  next();
}

module.exports = requireAuth;
