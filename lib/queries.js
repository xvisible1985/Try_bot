const gameDb = require('./gameDb');
const webDb = require('./webDb');

const HOSPITAL_EXIT_HEALTH = 30; // mirrors bot.js's own constant of the same name

// Mirrors bot.js's own getWeaponsFor(ownerType, ownerUserId) query shape —
// singleton weapons by weapon_key, individual owned_knives rows each
// becoming their own inventory slot. Re-derived here (not imported) since
// this is a separate process/repo with no code-sharing with bot.js.
function getWeaponsFor(userId) {
  const regular = gameDb.prepare(
    "SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ? " +
    "AND (expires_at IS NULL OR expires_at > strftime('%s','now'))"
  ).all(userId);
  const knives = gameDb.prepare(
    "SELECT id FROM owned_knives WHERE owner_user_id = ? AND is_dropped = 0 AND expires_at > strftime('%s','now')"
  ).all(userId).map(() => ({ weapon_key: 'knife' }));
  return [...regular.map(r => ({ weapon_key: r.weapon_key })), ...knives];
}

function getLeaderboard() {
  return gameDb.prepare(
    'SELECT user_id, xp, coins FROM pvp_stats WHERE is_warrior = 1 ORDER BY xp DESC'
  ).all().map((row, i) => ({
    userId: row.user_id,
    rank: i + 1,
    level: Math.floor(row.xp / 100),
    coins: row.coins,
  }));
}

function getFighter(userId) {
  const stats = gameDb.prepare('SELECT * FROM pvp_stats WHERE user_id = ?').get(userId);
  if (!stats || !stats.is_warrior) return null;

  const health = gameDb.prepare('SELECT * FROM user_health WHERE user_id = ?').get(userId) || {
    health: 100, max_health: 100, energy: 10, max_energy: 10, hospitalized_since: null, bleed_until: null,
  };
  const injury = gameDb.prepare(
    "SELECT injury_type, injured_until FROM injuries WHERE user_id = ? AND injured_until > strftime('%s','now')"
  ).get(userId);
  const known = gameDb.prepare('SELECT username, first_name FROM known_users WHERE user_id = ?').get(userId);

  const now = Math.floor(Date.now() / 1000);
  return {
    userId,
    displayName: known ? (known.username ? `@${known.username}` : known.first_name) : `игрок ${userId}`,
    level: Math.floor(stats.xp / 100),
    xp: stats.xp,
    accuracy: stats.accuracy,
    strength: stats.strength,
    agility: stats.agility,
    endurance: stats.endurance,
    coins: stats.coins,
    health: health.health,
    maxHealth: health.max_health,
    energy: health.energy,
    maxEnergy: health.max_energy,
    isHospitalized: !!health.hospitalized_since && health.health < HOSPITAL_EXIT_HEALTH,
    isBleeding: !!health.bleed_until && health.bleed_until > now,
    injury: injury ? { type: injury.injury_type, minutesLeft: Math.ceil((injury.injured_until - now) / 60) } : null,
    weapons: getWeaponsFor(userId),
  };
}

function getAvatarPath(userId) {
  const row = webDb.prepare('SELECT image_path FROM avatars WHERE user_id = ?').get(userId);
  return row ? row.image_path : null;
}

function getWeaponIcons() {
  const rows = webDb.prepare('SELECT weapon_key, image_path FROM weapon_icons').all();
  const byKey = {};
  for (const row of rows) byKey[row.weapon_key] = row.image_path;
  return byKey;
}

module.exports = { getLeaderboard, getFighter, getAvatarPath, getWeaponIcons };
