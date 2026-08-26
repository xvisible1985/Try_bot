require('dotenv').config();
const express = require('express');
const gameDb = require('./lib/gameDb');
const webDb = require('./lib/webDb');

const { getLeaderboard, getFighter } = require('./lib/queries');
const renderLeaderboard = require('./views/leaderboard');
const renderFighter = require('./views/fighter');

const app = express();

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
