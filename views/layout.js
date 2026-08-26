function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: sans-serif; max-width: 720px; margin: 24px auto; padding: 0 12px; }
    .bar-bg { background: #eee; border-radius: 4px; overflow: hidden; height: 10px; }
    .bar-fill { background: #4caf50; height: 100%; }
    .bar-fill.energy { background: #2196f3; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 4px 8px; text-align: left; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-right: 4px; }
    .badge.hospital { background: #ffe0e0; }
    .badge.bleed { background: #ffd0d0; }
    .badge.injury { background: #fff0d0; }
    .podium { display: flex; gap: 12px; justify-content: center; margin-bottom: 16px; }
    .podium a { text-decoration: none; color: inherit; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

module.exports = layout;
