const layout = require('./layout');

function renderLogin(botUsername) {
  return layout('Вход', `
    <h1>Вход через Telegram</h1>
    <script async src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${botUsername}"
      data-size="large"
      data-auth-url="/login/callback"
      data-request-access="write"></script>
  `);
}

module.exports = renderLogin;
