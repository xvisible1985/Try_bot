function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(403).send('Открой это приложение через кнопку в Telegram-боте.');
  }
  next();
}

module.exports = requireAuth;
