const layout = require('./layout');
const WEAPON_DEFS = require('../lib/weaponDefs');
const escapeHtml = require('../lib/escapeHtml');

const WEAPON_KEYS = ['bat', 'axe', 'scissors', 'knife', 'carrot', 'horns', 'crutch'];

function renderAdmin(iconsByWeaponKey, error) {
  const rows = WEAPON_KEYS.map((key) => `
    <tr>
      <td>${WEAPON_DEFS[key].emoji} ${WEAPON_DEFS[key].name}</td>
      <td>${iconsByWeaponKey[key] ? `<img src="/uploads/${iconsByWeaponKey[key]}" width="40" height="40">` : '(нет иконки)'}</td>
      <td>
        <form method="post" action="/admin/weapon-icon" enctype="multipart/form-data" style="display:inline;">
          <input type="hidden" name="weapon_key" value="${key}">
          <input type="file" name="icon" accept="image/jpeg,image/png,image/webp" required>
          <button type="submit">Загрузить</button>
        </form>
      </td>
    </tr>
  `).join('');

  return layout('Админка — иконки оружия', `
    <h1>Иконки оружия</h1>
    ${error ? `<p style="color:red;">${escapeHtml(error)}</p>` : ''}
    <table>${rows}</table>
  `);
}

module.exports = renderAdmin;
