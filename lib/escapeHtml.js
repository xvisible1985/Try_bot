// Any value that ultimately comes from a Telegram user's own profile data
// (first_name in particular — usernames are alphanumeric-only, but
// first_name has no such restriction) must be escaped before landing in
// an HTML template string, since every page in this app is public and
// unauthenticated. There is no templating engine here to do this
// automatically, so every view is responsible for calling this on
// anything user-controlled.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = escapeHtml;
