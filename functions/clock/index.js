// Cloudflare Pages Function — /clock/ (the Tello Staff time clock page).
// Serves the static clock page and adds the response headers that decide which
// websites may embed it. A customer's own site (e.g. title-22.com) may embed the
// clock only if the admin listed it under "Allowed websites" in the Time tab;
// everyone else is refused by the browser (frame-ancestors). Opening the clock
// as its own page always works.

const SUPABASE_URL = 'https://nwlhsshvqmbhemhxcran.supabase.co';
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

export async function onRequestGet(context) {
  const res = await context.next();
  const out = new Response(res.body, res);
  const ancestors = ["'self'"];
  try {
    const key = new URL(context.request.url).searchParams.get('k') || '';
    const serviceKey = context.env.SUPABASE_SERVICE_ROLE_KEY;
    if (KEY_RE.test(key) && serviceKey) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_config?clock_key=eq.${key}&select=clock_allowed_origins`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      const rows = r.ok ? await r.json() : [];
      const list = rows[0] && Array.isArray(rows[0].clock_allowed_origins) ? rows[0].clock_allowed_origins : [];
      list.forEach((o) => { if (typeof o === 'string' && ORIGIN_RE.test(o)) ancestors.push(o); });
    }
  } catch { /* fall back to 'self' only */ }
  out.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors.join(' ')}`);
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('Referrer-Policy', 'no-referrer');
  return out;
}
