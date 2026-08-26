require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const gameDb = require('./lib/gameDb');
const webDb = require('./lib/webDb');
const { verifyTelegramLogin } = require('./lib/telegramAuth');
const renderLogin = require('./views/login');

const path = require('path');
const { getLeaderboard, getFighter, getAvatarPath, getWeaponIcons } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');
const requireAuth = require('./lib/requireAuth');
const requireAdmin = require('./lib/requireAdmin');
const { makeUploader, extensionFor } = require('./lib/upload');
const renderAvatarForm = require('./views/avatarForm');
const renderAdmin = require('./views/admin');

// Uses the upload's real mimetype for the extension (jpg/png/webp) rather
// than hardcoding .jpg — a PNG saved as "foo.jpg" still displays fine in
// an <img> tag (browsers sniff the real format), but a mismatched
// extension is a latent trap for anything else that ever touches these
// files (a future resizer, "save as", social-preview unfurlers, etc).
const avatarUpload = makeUploader('avatars', (req, file) => `${req.session.userId}.${extensionFor(file.mimetype)}`);

const weaponIconUpload = makeUploader('weapons', (req, file) => `${req.body.weapon_key}.${extensionFor(file.mimetype)}`);
const KNOWN_WEAPON_KEYS = ['bat', 'axe', 'scissors', 'knife', 'carrot', 'horns', 'crutch'];

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

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/fighter/:id', (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).send('Неверный id');
  const avatarPath = getAvatarPath(userId);
  res.send(renderFighter(getFighter(userId), avatarPath ? `/uploads/${avatarPath}` : null, getWeaponIcons()));
});

app.get('/me/avatar', requireAuth, (req, res) => {
  res.send(renderAvatarForm(null));
});

app.post('/me/avatar', requireAuth, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) console.error('avatar upload error:', err.message);
    if (err || !req.file) {
      return res.send(renderAvatarForm('Не удалось загрузить файл — проверь формат (jpeg/png/webp) и размер (до 2 МБ).'));
    }
    webDb.prepare(
      'INSERT INTO avatars (user_id, image_path, uploaded_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET image_path = excluded.image_path, uploaded_at = excluded.uploaded_at'
    ).run(req.session.userId, `avatars/${req.file.filename}`, Math.floor(Date.now() / 1000));
    res.redirect(`/fighter/${req.session.userId}`);
  });
});

app.get('/admin', requireAdmin, (req, res) => {
  res.send(renderAdmin(getWeaponIcons(), null));
});

app.post('/admin/weapon-icon', requireAdmin, (req, res) => {
  // multer's own `enctype=multipart/form-data` parsing populates req.body
  // (including weapon_key) only DURING this call — it isn't available
  // before .single() runs, which is why weaponIconUpload's own filename
  // function reads req.body.weapon_key and why validity is re-checked
  // here afterward rather than in a separate earlier middleware.
  weaponIconUpload.single('icon')(req, res, (err) => {
    if (err) console.error('weapon icon upload error:', err.message);
    if (err || !req.file || !KNOWN_WEAPON_KEYS.includes(req.body.weapon_key)) {
      return res.send(renderAdmin(getWeaponIcons(), 'Не удалось загрузить — проверь тип оружия и формат файла.'));
    }
    webDb.prepare(
      'INSERT INTO weapon_icons (weapon_key, image_path, uploaded_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(weapon_key) DO UPDATE SET image_path = excluded.image_path, uploaded_at = excluded.uploaded_at'
    ).run(req.body.weapon_key, `weapons/${req.file.filename}`, Math.floor(Date.now() / 1000));
    res.redirect('/admin');
  });
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
