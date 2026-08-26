const layout = require('./layout');

function renderAvatarForm(error) {
  return layout('Моя аватарка', `
    <h1>Загрузить аватарку</h1>
    ${error ? `<p style="color:red;">${error}</p>` : ''}
    <form method="post" action="/me/avatar" enctype="multipart/form-data">
      <input type="file" name="avatar" accept="image/jpeg,image/png,image/webp" required>
      <button type="submit">Загрузить</button>
    </form>
  `);
}

module.exports = renderAvatarForm;
