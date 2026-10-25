// Cloudflare Pages Function — /api/staff-clock
//   GET  ?token=...                      → clock state for the staff member
//   POST { token, action }               → action: in | break_start | break_end | out
//
// Powers the Clock card on the public personal page (/my-shift.html). Same
// security pattern as staff-share-data.js: the staff share-link token is the
// access control, validated here on the server, and reads/writes use the
// Supabase SERVICE ROLE key (staff have no login). Rows are stored under the
// admin's user_id (the link's owner), and the admin reads them through RLS.
//
// Times: every punch is stamped with the SERVER clock, never the phone's
// clock, so a wrong or tampered device time can't change a timesheet. Shift
// start/end come from the schedule line (e.g. "Peter, 7am-3pm"); a line with
// no time just has no scheduled times, and the person can still clock in/out.
//
// Compliance notes (not legal advice — have your payroll/labor advisor
// confirm): unpaid breaks are deducted at their ACTUAL length; paid-break
// overage is only flagged for the admin to review; the app only REPORTS
// break overage and never tells anyone to shorten a later break.

const SUPABASE_URL = 'https://nwlhsshvqmbhemhxcran.supabase.co';
const DEFAULT_TZ = 'America/Los_Angeles';

// Placeholder break rules until the admin sets real ones (clock_settings on
// tello_staff_config). Applied to every shift, in the order listed.
const DEFAULT_SETTINGS = {
  timezone: DEFAULT_TZ,
  breaks: [
    { label: 'Rest break', minutes: 10, paid: true },
    { label: 'Rest break', minutes: 10, paid: true },
    { label: 'Meal break', minutes: 30, paid: false },
  ],
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function sbHeaders(serviceKey, extra = {}) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, ...extra };
}

async function sbGet(path, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders(serviceKey) });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

// ---- time zone helpers (Workers run in UTC, so do this explicitly) ----
function tzParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const o = {};
  parts.forEach((p) => { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

function localDateStr(date, tz) {
  const p = tzParts(date, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Wall-clock time in `tz` → UTC Date.
function zonedToUtc(dateStr, h, m, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, m, 0);
  for (let i = 0; i < 2; i += 1) {
    const p = tzParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    guess -= asUtc - Date.UTC(y, mo - 1, d, h, m, 0);
  }
  return new Date(guess);
}

// "7am", "7:30 pm", "15:00" → minutes after midnight (null if unreadable).
function parseClock(token) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(token || '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  } else if (h > 23) return null;
  return h * 60 + min;
}

function namesMatch(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function cleanSettings(raw) {
  const s = { timezone: DEFAULT_TZ, breaks: DEFAULT_SETTINGS.breaks };
  if (raw && typeof raw.timezone === 'string') {
    try { new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone }); s.timezone = raw.timezone; } catch { /* keep default */ }
  }
  if (raw && Array.isArray(raw.breaks)) {
    s.breaks = raw.breaks
      .filter((b) => b && Number(b.minutes) > 0)
      .map((b) => ({ label: String(b.label || 'Break').slice(0, 40), minutes: Math.round(Number(b.minutes)), paid: !!b.paid }));
  }
  return s;
}

// Everything the endpoint needs about who this link belongs to.
async function loadContext(token, serviceKey) {
  const { ok: linkOk, data: links } = await sbGet(
    `tello_staff_share_links?token=eq.${encodeURIComponent(token)}&revoked_at=is.null&select=*`, serviceKey);
  if (!linkOk || !Array.isArray(links) || !links.length || !links[0].staff_id) {
    return { error: json({ error: 'This link is invalid or has been revoked.' }, 404) };
  }
  const link = links[0];
  const { data: staffRows } = await sbGet(
    `tello_staff_members?id=eq.${encodeURIComponent(link.staff_id)}&user_id=eq.${link.user_id}&select=name`, serviceKey);
  if (!Array.isArray(staffRows) || !staffRows.length) {
    return { error: json({ error: 'This staff member no longer exists.' }, 404) };
  }
  const { data: cfgRows } = await sbGet(`tello_staff_config?user_id=eq.${link.user_id}&select=homes,clock_settings`, serviceKey);
  const cfg = Array.isArray(cfgRows) && cfgRows[0] ? cfgRows[0] : { homes: [], clock_settings: null };
  return {
    userId: link.user_id,
    staffId: link.staff_id,
    staffName: staffRows[0].name,
    homes: cfg.homes || [],
    settings: cleanSettings(cfg.clock_settings),
  };
}

// This person's scheduled shifts for yesterday..tomorrow, as absolute times.
async function loadShifts(ctx, now, serviceKey) {
  const tz = ctx.settings.timezone;
  const today = localDateStr(now, tz);
  const from = addDaysStr(today, -1);
  const to = addDaysStr(today, 1);
  const homeIds = ctx.homes.map((h) => h.id);
  if (!homeIds.length) return [];
  const nameById = {};
  ctx.homes.forEach((h) => { nameById[h.id] = h.name; });
  const { data } = await sbGet(
    `tello_staff_schedule_days?user_id=eq.${ctx.userId}&entity_kind=eq.home&entity_id=in.(${homeIds.map(encodeURIComponent).join(',')})&date=gte.${from}&date=lte.${to}&select=entity_id,date,working_shifts`,
    serviceKey);
  const shifts = [];
  (Array.isArray(data) ? data : []).forEach((row) => {
    (Array.isArray(row.working_shifts) ? row.working_shifts : []).forEach((s) => {
      if (!s || typeof s.name !== 'string' || !namesMatch(s.name, ctx.staffName)) return;
      const a = parseClock(s.start);
      const b = parseClock(s.end);
      if (a == null || b == null) return;
      const start = zonedToUtc(row.date, Math.floor(a / 60), a % 60, tz);
      // End at or before start means the shift runs past midnight.
      const end = zonedToUtc(b > a ? row.date : addDaysStr(row.date, 1), Math.floor(b / 60), b % 60, tz);
      shifts.push({
        date: row.date,
        homeName: nameById[row.entity_id] || 'your home',
        start: start.toISOString(),
        end: end.toISOString(),
        startLabel: s.start,
        endLabel: s.end,
      });
    });
  });
  shifts.sort((x, y) => x.start.localeCompare(y.start));
  return shifts;
}

async function loadEntries(ctx, now, serviceKey) {
  const since = new Date(now.getTime() - 15 * 86400000).toISOString();
  const { data } = await sbGet(
    `tello_staff_clock_entries?user_id=eq.${ctx.userId}&staff_id=eq.${encodeURIComponent(ctx.staffId)}&clock_in=gte.${since}&order=clock_in.desc&select=*`,
    serviceKey);
  const entries = Array.isArray(data) ? data : [];
  const { data: openRows } = await sbGet(
    `tello_staff_clock_entries?user_id=eq.${ctx.userId}&staff_id=eq.${encodeURIComponent(ctx.staffId)}&clock_out=is.null&select=*`,
    serviceKey);
  const open = Array.isArray(openRows) && openRows[0] ? openRows[0] : null;
  if (open && !entries.find((e) => e.id === open.id)) entries.unshift(open); // forgot to clock out long ago
  return { entries, open };
}

async function stateResponse(ctx, now, serviceKey, extra = {}) {
  const [shifts, { entries, open }] = await Promise.all([
    loadShifts(ctx, now, serviceKey),
    loadEntries(ctx, now, serviceKey),
  ]);
  return json({
    staffName: ctx.staffName,
    serverNow: now.toISOString(),
    timezone: ctx.settings.timezone,
    breaks: ctx.settings.breaks,
    shifts,
    open,
    entries,
    ...extra,
  });
}

export async function onRequestGet({ request, env }) {
  const token = (new URL(request.url).searchParams.get('token') || '').trim();
  if (!token) return json({ error: 'Missing token' }, 400);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' }, 500);
  const ctx = await loadContext(token, serviceKey);
  if (ctx.error) return ctx.error;
  return stateResponse(ctx, new Date(), serviceKey);
}

async function patchEntry(id, userId, patch, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_clock_entries?id=eq.${id}&user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  return res.ok;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const action = body?.action;
  if (!token) return json({ error: 'Missing token' }, 400);
  if (!['in', 'break_start', 'break_end', 'out'].includes(action)) return json({ error: 'Unknown action' }, 400);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' }, 500);

  const ctx = await loadContext(token, serviceKey);
  if (ctx.error) return ctx.error;
  const now = new Date();
  const nowIso = now.toISOString();
  const { open } = await loadEntries(ctx, now, serviceKey);

  if (action === 'in') {
    if (open) return stateResponse(ctx, now, serviceKey, { notice: 'already_in' });
    // Attach the scheduled shift this punch most plausibly belongs to.
    const shifts = await loadShifts(ctx, now, serviceKey);
    const t = now.getTime();
    const match = shifts.find((s) => t >= new Date(s.start).getTime() - 60 * 60000 && t <= new Date(s.end).getTime() + 2 * 3600000);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_clock_entries`, {
      method: 'POST',
      headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        user_id: ctx.userId,
        staff_id: ctx.staffId,
        staff_name: ctx.staffName,
        home_name: match ? match.homeName : null,
        sched_start: match ? match.start : null,
        sched_end: match ? match.end : null,
        clock_in: nowIso,
        orig_clock_in: nowIso,
        breaks: [],
      }),
    });
    if (!res.ok) {
      // The one-open-entry-per-person index turns a double tap into a conflict.
      if (res.status === 409) return stateResponse(ctx, now, serviceKey, { notice: 'already_in' });
      return json({ error: 'Could not clock in. Try again in a moment.' }, 502);
    }
    return stateResponse(ctx, now, serviceKey, { notice: 'clocked_in' });
  }

  if (!open) return json({ error: "You're not clocked in." }, 409);
  const breaks = Array.isArray(open.breaks) ? open.breaks : [];
  const openBreak = breaks.length && !breaks[breaks.length - 1].end ? breaks[breaks.length - 1] : null;

  if (action === 'break_start') {
    if (openBreak) return stateResponse(ctx, now, serviceKey, { notice: 'already_on_break' });
    const def = ctx.settings.breaks[breaks.length];
    if (!def) return json({ error: 'No more breaks are set up for a shift.' }, 409);
    const next = [...breaks, { label: def.label, allowed: def.minutes, paid: def.paid, start: nowIso }];
    if (!(await patchEntry(open.id, ctx.userId, { breaks: next }, serviceKey))) {
      return json({ error: 'Could not start the break. Try again.' }, 502);
    }
    return stateResponse(ctx, now, serviceKey, { notice: 'break_started' });
  }

  if (action === 'break_end') {
    if (!openBreak) return stateResponse(ctx, now, serviceKey, { notice: 'not_on_break' });
    const next = breaks.map((b) => (b === openBreak ? { ...b, end: nowIso } : b));
    if (!(await patchEntry(open.id, ctx.userId, { breaks: next }, serviceKey))) {
      return json({ error: 'Could not end the break. Try again.' }, 502);
    }
    return stateResponse(ctx, now, serviceKey, { notice: 'break_ended' });
  }

  // out
  if (openBreak) return json({ error: 'End your break first, then clock out.' }, 409);
  if (!(await patchEntry(open.id, ctx.userId, { clock_out: nowIso, orig_clock_out: nowIso }, serviceKey))) {
    return json({ error: 'Could not clock out. Try again.' }, 502);
  }
  return stateResponse(ctx, now, serviceKey, { notice: 'clocked_out' });
}
