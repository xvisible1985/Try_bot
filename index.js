require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const gameDb = require('./lib/gameDb');
const webDb = require('./lib/webDb');
const { verifyTelegramLogin } = require('./lib/telegramAuth');
const renderLogin = require('./views/login');

const { getLeaderboard, getFighter } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');

const app = express();
// Needed so req.protocol reflects the real scheme when this sits behind a
// reverse proxy terminating HTTPS (see Task 6's deployment) — without it,
// Express always sees plain HTTP from the proxy, and the `secure` cookie
// flag below would silently never take effect.
app.set('trust proxy', 1);
app.use(cookieSession({
  name: 'session',
  secret: process.env.SESSION_SECRET,
  maxAge: 30 * 24 * 60 * 60 * 1000,
  // Only mark the cookie Secure in production — local http dev testing
  // (NODE_ENV unset) would otherwise silently never set the cookie at all.
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
}));

app.get('/login', (req, res) => {
  res.send(renderLogin(process.env.TG_BOT_USERNAME));
});

app.get('/login/callback', (req, res) => {
  const ok = verifyTelegramLogin(req.query, process.env.TG_BOT_TOKEN);
  if (!ok) return res.status(403).send('Не удалось подтвердить вход через Telegram.');
  req.session.userId = Number(req.query.id);
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.get('/', (req, res) => {
  res.send(renderLeaderboard(getLeaderboard()));
});

app.get('/fighter/:id', (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).send('Неверный id');
  res.send(renderFighter(getFighter(userId)));
});

app.get('/healthz', (req, res) => {
  // Touches both connections once at request time, cheaply, so a broken
  // GAME_DB_PATH or a corrupt web.db surfaces immediately instead of
  // silently failing on the first real page view.
  const gameOk = !!gameDb.prepare('SELECT 1').get();
  const webOk = !!webDb.prepare('SELECT 1').get();
  res.json({ gameDb: gameOk, webDb: webOk });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`tg-web listening on port ${port}`);
});
