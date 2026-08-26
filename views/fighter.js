const layout = require('./layout');
const WEAPON_DEFS = require('../lib/weaponDefs');
const escapeHtml = require('../lib/escapeHtml');

// Falls back to a generic label rather than throwing — this app keeps its
// own independent copy of WEAPON_DEFS (bot.js has its own, troll-bot has
// its own too), and this exact class of drift has already caused real
// crashes across this project's repos before (a weapon added on one side
// but not the other). An unrecognized weapon_key should degrade to "❓",
// not 500 the whole profile page.
function weaponDisplay(weaponKey) {
  return WEAPON_DEFS[weaponKey] || { name: weaponKey, emoji: '❓' };
}

function renderFighter(fighter, avatarUrl, weaponIcons) {
  if (!fighter) {
    return layout('Боец', '<h1>Ещё не воин</h1><p>Этот игрок пока не зарегистрирован как воин.</p>');
  }

  const safeName = escapeHtml(fighter.displayName);

  // injury.type is one of a fixed enum ('arm' | 'leg' | 'head') written
  // only by tg-bot's own combat logic, never user free text — no
  // escaping needed, same trust level as fighter.level/coins/etc.
  const INJURY_NAMES = { arm: 'рука', leg: 'нога', head: 'голова' };
  const badges = [
    fighter.isHospitalized ? '<span class="badge hospital">🏥 в больничке</span>' : '',
    fighter.isBleeding ? '<span class="badge bleed">🩸 кровоточит</span>' : '',
    fighter.injury ? `<span class="badge injury">🤕 травма: ${INJURY_NAMES[fighter.injury.type] || fighter.injury.type} (${fighter.injury.minutesLeft} мин)</span>` : '',
  ].join('');

  const weaponHtml = fighter.weapons.map(w => {
    const def = weaponDisplay(w.weapon_key);
    const iconPath = weaponIcons[w.weapon_key];
    return iconPath
      ? `<img src="/uploads/${iconPath}" title="${escapeHtml(def.name)}" width="24" height="24">`
      : `<span title="${escapeHtml(def.name)}">${def.emoji}</span>`;
  }).join(' ') || '(пусто)';

  return layout(fighter.displayName, `
    <h1>${safeName} — уровень ${fighter.level}</h1>
    ${avatarUrl ? `<img src="${avatarUrl}" alt="" width="80" height="80" style="border-radius:50%;object-fit:cover;">` : ''}
    <div>${badges}</div>
    <table>
      <tr><td>Точность</td><td>${fighter.accuracy}</td><td>Сила</td><td>${fighter.strength}</td></tr>
      <tr><td>Ловкость</td><td>${fighter.agility}</td><td>Выносливость</td><td>${fighter.endurance}</td></tr>
    </table>
    <p>❤️ Здоровье: ${fighter.health}/${fighter.maxHealth}</p>
    <div class="bar-bg"><div class="bar-fill" style="width:${Math.round(100 * fighter.health / fighter.maxHealth)}%"></div></div>
    <p>⚡ Энергия: ${fighter.energy}/${fighter.maxEnergy}</p>
    <div class="bar-bg"><div class="bar-fill energy" style="width:${Math.round(100 * fighter.energy / fighter.maxEnergy)}%"></div></div>
    <p>🪙 Монеты: ${fighter.coins}</p>
    <p>Оружие: ${weaponHtml}</p>
  `);
}

module.exports = renderFighter;
