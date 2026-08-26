const layout = require('./layout');

function renderLeaderboard(fighters) {
  const top3 = fighters.slice(0, 3);
  const rest = fighters.slice(3);

  const podiumHtml = top3.map(f => `
    <a href="/fighter/${f.userId}">
      <div style="text-align:center;">
        <div>${f.rank === 1 ? '🥇' : f.rank === 2 ? '🥈' : '🥉'}</div>
        <div>Ур. ${f.level}</div>
        <div>${f.coins} 🪙</div>
      </div>
    </a>
  `).join('');

  const restRows = rest.map(f => `
    <tr>
      <td>${f.rank}</td>
      <td><a href="/fighter/${f.userId}">Игрок ${f.userId}</a></td>
      <td>Ур. ${f.level}</td>
      <td>${f.coins} 🪙</td>
    </tr>
  `).join('');

  return layout('Таблица лидеров', `
    <h1>Таблица лидеров</h1>
    ${fighters.length === 0 ? '<p>Пока нет ни одного воина.</p>' : `
      <div class="podium">${podiumHtml}</div>
      <table>${restRows}</table>
    `}
  `);
}

module.exports = renderLeaderboard;
