// Cloudflare Pages Function — POST /api/share-request
// Lets an unauthenticated share-page visitor submit a change request
// ("need Friday off", "can someone cover Tuesday night"). Validates the
// token and writes via the Supabase SERVICE ROLE key, same reasoning as
// share-data.js — the token is the access control, checked here server-side.

const SUPABASE_URL = 'https://nwlhsshvqmbhemhxcran.supabase.co';
const MAX_NOTE_LENGTH = 2000;
const MAX_NAME_LENGTH = 200;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function supabaseGet(path, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' }, 500);
  }

  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const staffName = typeof body?.staffName === 'string' ? body.staffName.trim().slice(0, MAX_NAME_LENGTH) : '';
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, MAX_NOTE_LENGTH) : '';
  const requestDate = typeof body?.requestDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.requestDate)
    ? body.requestDate
    : null;

  if (!token || !staffName || !note) {
    return json({ error: 'Name and a note are required.' }, 400);
  }

  const linkQuery = `tello_staff_share_links?token=eq.${encodeURIComponent(token)}&revoked_at=is.null&select=*`;
  const { ok: linkOk, data: links } = await supabaseGet(linkQuery, serviceKey);
  if (!linkOk || !Array.isArray(links) || links.length === 0) {
    return json({ error: 'This link is invalid or has been revoked.' }, 404);
  }
  const link = links[0];

  const { data: configRows } = await supabaseGet(
    `tello_staff_config?user_id=eq.${link.user_id}&select=homes`,
    serviceKey
  );
  const home = (configRows?.[0]?.homes || []).find((h) => h.id === link.home_id);
  const homeName = home ? home.name : 'Unknown home';

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_requests`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      user_id: link.user_id,
      home_id: link.home_id,
      home_name: homeName,
      staff_name: staffName,
      request_date: requestDate,
      note,
    }),
  });

  if (!insertRes.ok) {
    return json({ error: 'Could not submit the request. Try again in a moment.' }, 502);
  }

  return json({ ok: true });
}
