export default async function handler(req, res) {
  const code = req.query && req.query.code;
  if (req.query && req.query.error) return res.status(400).send('WHOOP auth error: ' + req.query.error);
  if (!code) return res.status(400).send('Missing code parameter.');
  const clientId     = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  const redirectUri  = process.env.WHOOP_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).send('Server not configured (missing WHOOP_* env vars).');
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: clientId, client_secret: clientSecret,
    });
    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) return res.status(500).send('WHOOP token exchange failed: ' + text);
    let json;
    try { json = JSON.parse(text); } catch { return res.status(500).send('Non-JSON: ' + text); }
    const access = json.access_token || '';
    const refresh = json.refresh_token || '';
    const expiresIn = json.expires_in || 3600;
    const hash = new URLSearchParams({
      whoop_access: access, whoop_refresh: refresh,
      whoop_expires: String(Date.now() + expiresIn * 1000),
    }).toString();
    res.writeHead(302, { Location: '/health.html#' + hash });
    res.end();
  } catch (e) {
    res.status(500).send('Unexpected: ' + (e.message || String(e)));
  }
}
