const Database = require('better-sqlite3');

const gameDbPath = process.env.GAME_DB_PATH;
if (!gameDbPath) {
  throw new Error('GAME_DB_PATH env var is not set — see .env.example');
}

// readonly: true makes better-sqlite3 itself refuse any write attempt at
// the driver level — this connection must NEVER become a place a write
// accidentally lands, since mutes.db is live state shared with tg-bot
// and troll-bot, both still running as separate processes.
const gameDb = new Database(gameDbPath, { readonly: true, fileMustExist: true });

module.exports = gameDb;
