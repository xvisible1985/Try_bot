function getAdminUserIds() {
  return (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(403).send('Открой это приложение через кнопку в Telegram-боте.');
  }
  if (!getAdminUserIds().includes(req.session.userId)) {
    return res.status(403).send('Доступ только для администраторов.');
  }
  next();
}

module.exports = requireAdmin;
