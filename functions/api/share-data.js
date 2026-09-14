// Cloudflare Pages Function — GET /api/share-data?token=...
// Powers the public, unauthenticated share page (/share.html). Reads via the
// Supabase SERVICE ROLE key (bypasses RLS) rather than loosening RLS to allow
// public reads — the token itself is the access control, validated here on
// the server, never in the browser.

const SUPABASE_URL = 'https://nwlhsshvqmbhemhxcran.supabase.co';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toISODate(d) {
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
}

function startOfWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

async function supabaseGet(path, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return json({ error: 'Missing token' }, 400);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' }, 500);
  }

  const linkQuery = `tello_staff_share_links?token=eq.${encodeURIComponent(token)}&revoked_at=is.null&select=*`;
  const { ok: linkOk, data: links } = await supabaseGet(linkQuery, serviceKey);
  if (!linkOk || !Array.isArray(links) || links.length === 0) {
    return json({ error: 'This link is invalid or has been revoked.' }, 404);
  }
  const link = links[0];

  const { ok: configOk, data: configRows } = await supabaseGet(
    `tello_staff_config?user_id=eq.${link.user_id}&select=homes,relievers`,
    serviceKey
  );
  if (!configOk || !Array.isArray(configRows) || configRows.length === 0) {
    return json({ error: 'Could not load schedule data.' }, 500);
  }
  const config = configRows[0];
  const home = (config.homes || []).find((h) => h.id === link.home_id);
  if (!home) {
    return json({ error: 'This home no longer exists.' }, 404);
  }

  const now = new Date();
  const ws = startOfWeekMonday(now);
  const days = DAY_LABELS.map((label, i) => ({ label, date: addDays(ws, i) }));
  const startStr = toISODate(ws);
  const endStr = toISODate(addDays(ws, 6));
  const todayStr = toISODate(now);

  const { data: homeDays } = await supabaseGet(
    `tello_staff_schedule_days?user_id=eq.${link.user_id}&entity_kind=eq.home&entity_id=eq.${encodeURIComponent(link.home_id)}&date=gte.${startStr}&date=lte.${endStr}&select=date,working,day_off`,
    serviceKey
  );
  const homeDayMap = {};
  (Array.isArray(homeDays) ? homeDays : []).forEach((row) => {
    homeDayMap[row.date] = { working: row.working || '', day_off: row.day_off || '' };
  });

  const relievers = Array.isArray(config.relievers) ? config.relievers : [];
  const relieverIds = relievers.map((r) => r.id);
  let relieverDayMap = {};
  if (relieverIds.length) {
    const { data: relieverDays } = await supabaseGet(
      `tello_staff_schedule_days?user_id=eq.${link.user_id}&entity_kind=eq.reliever&entity_id=in.(${relieverIds.join(',')})&date=gte.${startStr}&date=lte.${endStr}&select=entity_id,date,working`,
      serviceKey
    );
    (Array.isArray(relieverDays) ? relieverDays : []).forEach((row) => {
      relieverDayMap[row.entity_id] = relieverDayMap[row.entity_id] || {};
      relieverDayMap[row.entity_id][row.date] = row.working || '';
    });
  }

  return json({
    homeName: home.name,
    weekLabel: `${startStr} to ${endStr}`,
    today: todayStr,
    days: days.map((d) => {
      const dateStr = toISODate(d.date);
      const cell = homeDayMap[dateStr] || { working: '', day_off: '' };
      return { label: d.label, date: dateStr, working: cell.working, dayOff: cell.day_off };
    }),
    relievers: relievers.map((r) => ({
      name: r.name,
      deployments: days
        .map((d) => {
          const dateStr = toISODate(d.date);
          const val = (relieverDayMap[r.id] || {})[dateStr];
          return val ? { label: d.label, value: val } : null;
        })
        .filter(Boolean),
    })),
  });
}
