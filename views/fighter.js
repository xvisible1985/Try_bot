const layout = require('./layout');
const WEAPON_DEFS = require('../lib/weaponDefs');

function renderFighter(fighter) {
  if (!fighter) {
    return layout('Боец', '<h1>Ещё не воин</h1><p>Этот игрок пока не зарегистрирован как воин.</p>');
  }

  const badges = [
    fighter.isHospitalized ? '<span class="badge hospital">🏥 в больничке</span>' : '',
    fighter.isBleeding ? '<span class="badge bleed">🩸 кровоточит</span>' : '',
    fighter.injury ? `<span class="badge injury">🤕 травма (${fighter.injury.minutesLeft} мин)</span>` : '',
  ].join('');

  const weaponIcons = fighter.weapons.map(w => `<span title="${WEAPON_DEFS[w.weapon_key].name}">${WEAPON_DEFS[w.weapon_key].emoji}</span>`).join(' ') || '(пусто)';

  return layout(fighter.displayName, `
    <h1>${fighter.displayName} — уровень ${fighter.level}</h1>
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
    <p>Оружие: ${weaponIcons}</p>
  `);
}

module.exports = renderFighter;
