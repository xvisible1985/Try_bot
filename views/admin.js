const layout = require('./layout');
const WEAPON_DEFS = require('../lib/weaponDefs');
const escapeHtml = require('../lib/escapeHtml');

// Derived from WEAPON_DEFS rather than hardcoded — a separately
// maintained copy of this list has already caused real crashes
// elsewhere in this project when a weapon was added on one side but not
// the other (see views/fighter.js's weaponDisplay() comment).
const WEAPON_KEYS = Object.keys(WEAPON_DEFS);

function renderAdmin(iconsByWeaponKey, error) {
  const rows = WEAPON_KEYS.map((key) => {
    // WEAPON_KEYS is derived directly from WEAPON_DEFS above, so this
    // lookup can't actually miss today — guarded anyway so a future
    // refactor that decouples the two doesn't turn into a 500 here,
    // matching the defensive posture views/fighter.js already uses for
    // the exact same underlying data.
    const def = WEAPON_DEFS[key] || { name: key, emoji: '❓' };
    return `
    <tr>
      <td>${def.emoji} ${escapeHtml(def.name)}</td>
      <td>${iconsByWeaponKey[key] ? `<img src="/uploads/${iconsByWeaponKey[key]}" width="40" height="40">` : '(нет иконки)'}</td>
      <td>
        <form method="post" action="/admin/weapon-icon" enctype="multipart/form-data" style="display:inline;">
          <input type="hidden" name="weapon_key" value="${key}">
          <input type="file" name="icon" accept="image/jpeg,image/png,image/webp" required>
          <button type="submit">Загрузить</button>
        </form>
      </td>
    </tr>
  `;
  }).join('');

  return layout('Админка — иконки оружия', `
    <h1>Иконки оружия</h1>
    ${error ? `<p style="color:red;">${escapeHtml(error)}</p>` : ''}
    <table>${rows}</table>
  `);
}

module.exports = renderAdmin;
