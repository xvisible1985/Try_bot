const path = require('path');
const Database = require('better-sqlite3');

const webDb = new Database(path.join(__dirname, '..', 'web.db'));

webDb.exec(`
  CREATE TABLE IF NOT EXISTS avatars (
    user_id INTEGER PRIMARY KEY,
    image_path TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL
  )
`);
webDb.exec(`
  CREATE TABLE IF NOT EXISTS weapon_icons (
    weapon_key TEXT PRIMARY KEY,
    image_path TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL
  )
`);

module.exports = webDb;
