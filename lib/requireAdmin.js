function getAdminUserIds() {
  return (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

// Same message as lib/requireAuth.js, deliberately — see its comment
// for why this covers both "opened outside Telegram" and "auto-login
// failed silently" with one actionable instruction.
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(403).send('Не удалось войти автоматически. Закрой и снова открой приложение через кнопку в Telegram-боте.');
  }
  if (!getAdminUserIds().includes(req.session.userId)) {
    return res.status(403).send('Доступ только для администраторов.');
  }
  next();
}

module.exports = requireAdmin;
