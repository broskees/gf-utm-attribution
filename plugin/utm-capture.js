// Runs inline in the head, independently of any deferred scripts.
(() => {
  const cookieName = 'gf_utm_attribution';
  if (document.cookie.split(';').some(cookie => cookie.trim().indexOf(`${cookieName}=`) === 0)) return;

  const queryParameters = new URLSearchParams(window.location.search);
  const campaign = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(parameter => {
    const value = queryParameters.get(parameter);
    if (!value || !value.trim()) return;

    const characters = Array.from(value.trim()).slice(0, 200);
    // Budget each field as stored (JSON-escaped, then URL-encoded) so the complete cookie stays below 4 KB.
    while (encodeURIComponent(JSON.stringify(characters.join(''))).length > 600) characters.pop();
    campaign[parameter] = characters.join('');
  });

  if (!Object.keys(campaign).length) return;

  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${cookieName}=${encodeURIComponent(JSON.stringify(campaign))}; path=/; SameSite=Lax${secure}`;
})();
