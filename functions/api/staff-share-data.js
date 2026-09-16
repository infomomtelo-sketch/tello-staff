// Cloudflare Pages Function — GET /api/staff-share-data?token=...&month=YYYY-MM
// Powers the public, unauthenticated personal schedule page (/my-shift.html)
// — a staff member's own "where + what time do I work" view, for a whole
// calendar month at a time (?month defaults to the current month). Same
// security pattern as /api/share-data.js: reads via the Supabase SERVICE
// ROLE key (bypasses RLS) rather than loosening RLS, with the token itself
// as the access control, validated here on the server, never in the browser.
//
// Matching a name against the schedule is necessarily best-effort: the
// Schedule Board is free text, not a dropdown of staff IDs, so a person's
// shift is found by looking for their exact (case-insensitive) name in each
// home's working_shifts (for a time) or day_off text (for a day off) across
// every home, not by any real foreign key.

const SUPABASE_URL = 'https://nwlhsshvqmbhemhxcran.supabase.co';

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

function monthKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function parseMonthParam(monthStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr || '');
  if (!m) return null;
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return { year: Number(m[1]), monthIndex };
}

function namesMatch(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
  if (!linkOk || !Array.isArray(links) || links.length === 0 || !links[0].staff_id) {
    return json({ error: 'This link is invalid or has been revoked.' }, 404);
  }
  const link = links[0];

  const { ok: staffOk, data: staffRows } = await supabaseGet(
    `tello_staff_members?id=eq.${encodeURIComponent(link.staff_id)}&user_id=eq.${link.user_id}&select=name`,
    serviceKey
  );
  if (!staffOk || !Array.isArray(staffRows) || staffRows.length === 0) {
    return json({ error: 'This staff member no longer exists.' }, 404);
  }
  const staffName = staffRows[0].name;

  const { ok: configOk, data: configRows } = await supabaseGet(
    `tello_staff_config?user_id=eq.${link.user_id}&select=homes`,
    serviceKey
  );
  if (!configOk || !Array.isArray(configRows) || configRows.length === 0) {
    return json({ error: 'Could not load schedule data.' }, 500);
  }
  const homes = configRows[0].homes || [];
  const homeIds = homes.map((h) => h.id);
  const homeNameById = {};
  homes.forEach((h) => { homeNameById[h.id] = h.name; });

  const now = new Date();
  const todayStr = toISODate(now);
  const { year, monthIndex } = parseMonthParam(url.searchParams.get('month'))
    || { year: now.getFullYear(), monthIndex: now.getMonth() };

  const monthStart = new Date(year, monthIndex, 1);
  const monthEnd = new Date(year, monthIndex + 1, 0);
  const daysInMonth = monthEnd.getDate();
  const startStr = toISODate(monthStart);
  const endStr = toISODate(monthEnd);
  const prevMonthDate = new Date(year, monthIndex - 1, 1);
  const nextMonthDate = new Date(year, monthIndex + 1, 1);

  let rows = [];
  if (homeIds.length) {
    const { data } = await supabaseGet(
      `tello_staff_schedule_days?user_id=eq.${link.user_id}&entity_kind=eq.home&entity_id=in.(${homeIds.join(',')})&date=gte.${startStr}&date=lte.${endStr}&select=entity_id,date,day_off,working_shifts`,
      serviceKey
    );
    rows = Array.isArray(data) ? data : [];
  }

  // date -> { shifts: [{homeName, start, end}], dayOff: bool }
  const byDate = {};
  rows.forEach((row) => {
    const bucket = byDate[row.date] || { shifts: [], dayOff: false };
    const homeName = homeNameById[row.entity_id] || 'Unknown home';
    (Array.isArray(row.working_shifts) ? row.working_shifts : []).forEach((s) => {
      if (s && typeof s.name === 'string' && namesMatch(s.name, staffName)) {
        bucket.shifts.push({ homeName, start: s.start || null, end: s.end || null });
      }
    });
    (row.day_off || '').split('\n').forEach((line) => {
      if (line.trim() && namesMatch(line, staffName)) bucket.dayOff = true;
    });
    byDate[row.date] = bucket;
  });

  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = new Date(year, monthIndex, i + 1);
    const dateStr = toISODate(date);
    const bucket = byDate[dateStr] || { shifts: [], dayOff: false };
    const status = bucket.shifts.length ? 'working' : (bucket.dayOff ? 'dayOff' : 'none');
    return {
      date: dateStr,
      dayOfMonth: i + 1,
      weekday: date.toLocaleDateString('en-US', { weekday: 'short' }),
      status,
      shifts: bucket.shifts,
    };
  });

  return json({
    staffName,
    today: todayStr,
    monthLabel: monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    month: monthKey(year, monthIndex),
    prevMonth: monthKey(prevMonthDate.getFullYear(), prevMonthDate.getMonth()),
    nextMonth: monthKey(nextMonthDate.getFullYear(), nextMonthDate.getMonth()),
    days,
  });
}
