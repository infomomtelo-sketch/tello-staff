// Cloudflare Pages Function — /api/staff-clock
//   POST { action: 'roster', key }               → names for the "tap your name" list
//   POST { action: 'login', key, staffId | empNo, pin } → session token + clock state
//   GET  (Authorization: Bearer <session>)    → clock state for the staff member
//   POST { action } (Bearer <session>)        → consent | in | break_start | break_end | out
//
// Powers the Tello Staff clock page (/clock/, also embedded as a widget on a
// customer's own site via /embed.js). Staff sign in there with an employee
// number + PIN the admin set up; the signed session token is the access control,
// validated here on the server, and reads/writes use the Supabase SERVICE ROLE
// key (staff have no Supabase login). Rows are stored under the admin's user_id
// and the admin reads them through RLS. Staff can only clock in/out and read
// their own hours and schedule — nothing else in the app.
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
//
// Who is punching, and where (schema_clock_v2.sql). The employee number + PIN
// say WHICH staff member's clock this is, and every clock-in and clock-out must
// also carry (1) a live selfie and (2) the phone's location at that moment:
//   * consent — the person must have accepted the photo/location notice
//     (CONSENT_VERSION) before their first punch; recorded in
//     tello_staff_clock_consent.
//   * location — checked HERE on the server against the home's saved location
//     (homes[].geo = { lat, lng, radius } set by the admin in the Time tab). A
//     punch outside the radius is refused; the admin can still correct hours in
//     the Time tab, so no worked time is lost. A home with no saved location is
//     not location-checked (and no location is collected for it). Location is
//     read ONLY at the moment of a punch — never tracked in the background.
//   * photo — stored in the private 'clock-photos' bucket for the admin to
//     review; deleted automatically after PHOTO_DAYS. This is a plain photo for
//     a person to look at: NO face matching, NO face template is ever created.
// The browser can be fooled by a mocked GPS or a held-up photo, so the photo
// trail is what lets the admin catch a "punch for me" — this is a deterrent and
// an audit record, not proof.

const SUPABASE_URL = 'https://nwlhsshvqmbhemhxcran.supabase.co';
const DEFAULT_TZ = 'America/Los_Angeles';

const CONSENT_VERSION = '2026-11';   // bump when the notice text changes
const PHOTO_BUCKET = 'clock-photos';
const PHOTO_DAYS = 90;                // retention for clock-in/out photos
const MAX_PHOTO_BYTES = 250000;
const DEFAULT_RADIUS_M = 150;         // home radius when the admin leaves it at the default
const MAX_ACCURACY_M = 150;           // refuse a fix less precise than this
const ACCURACY_CREDIT_M = 100;        // GPS wobble indoors: forgive up to this much

// Fields staff never need back (photo paths, coordinates).
const PRIVATE_ENTRY_FIELDS = [
  'in_photo', 'out_photo',
  'in_lat', 'in_lng', 'in_accuracy_m', 'in_distance_m',
  'out_lat', 'out_lng', 'out_accuracy_m', 'out_distance_m',
];

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
  return { ok: res.ok, status: res.status, data };
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

// ---- location + photo helpers ----
function validGeo(g) {
  if (!g) return false;
  const lat = Number(g.lat), lng = Number(g.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function radiusOf(g) {
  const r = Number(g.radius);
  return Number.isFinite(r) ? Math.min(500, Math.max(50, Math.round(r))) : DEFAULT_RADIUS_M;
}

// Great-circle distance in metres.
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function fmtDist(m) {
  return m < 1000 ? `${Math.max(1, Math.round(m))} m` : `${(m / 1609.344).toFixed(1)} miles`;
}

function readPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat), lng = Number(raw.lng), accuracy = Number(raw.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!Number.isFinite(accuracy) || accuracy < 0) return null;
  return { lat, lng, accuracy };
}

// Is this fix inside the home it should be at? `homeName` is the home the
// shift/entry belongs to (null = any home that has a saved location).
function checkLocation(ctx, pos, homeName, verb) {
  const geoHomes = ctx.homes.filter((h) => validGeo(h.geo));
  if (!geoHomes.length) return { enforced: false };
  let targets = geoHomes;
  if (homeName) {
    const named = ctx.homes.filter((h) => namesMatch(h.name, homeName));
    if (named.length) {
      targets = named.filter((h) => validGeo(h.geo));
      if (!targets.length) return { enforced: false }; // that home has no saved location yet
    }
  }
  if (!pos) {
    return { enforced: true, error: 'location_required', message: `Your location is needed to clock ${verb}. Allow location for this page in your browser, then try again.` };
  }
  if (pos.accuracy > MAX_ACCURACY_M) {
    return { enforced: true, error: 'location_imprecise', message: `Your phone's location isn't precise enough right now (about ${Math.round(pos.accuracy)} m). Turn on precise location, step near a window or outside, and try again.` };
  }
  let best = null;
  targets.forEach((h) => {
    const dist = distanceM(pos.lat, pos.lng, Number(h.geo.lat), Number(h.geo.lng));
    if (!best || dist < best.dist) best = { home: h, dist };
  });
  const credit = Math.min(pos.accuracy, ACCURACY_CREDIT_M);
  if (best.dist - credit > radiusOf(best.home.geo)) {
    return {
      enforced: true,
      error: 'outside_area',
      message: `You're about ${fmtDist(best.dist)} from ${best.home.name}. You need to be at the home to clock ${verb}. If you are at work and this looks wrong, tell your admin.`,
    };
  }
  return { enforced: true, ok: true, home: best.home, dist: best.dist };
}

// "data:image/jpeg;base64,..." → bytes (null if it isn't a plausible JPEG).
function decodePhoto(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
  if (!m || m[1].length > MAX_PHOTO_BYTES * 1.4) return null;
  let bin;
  try { bin = atob(m[1]); } catch { return null; }
  if (bin.length < 800 || bin.length > MAX_PHOTO_BYTES) return null; // tiny = not a real camera frame
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return bytes;
}

async function putPhoto(path, bytes, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: sbHeaders(serviceKey, { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }),
    body: bytes,
  });
  return res.ok;
}

async function deletePhotos(paths, serviceKey) {
  if (!paths.length) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}`, {
    method: 'DELETE',
    headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: paths }),
  });
}

// Retention: photos older than PHOTO_DAYS are deleted. Runs after a punch (staff
// punch daily), a bounded batch at a time; the time record itself is untouched.
async function purgeOldPhotos(ctx, now, serviceKey) {
  try {
    const cutoff = new Date(now.getTime() - PHOTO_DAYS * 86400000).toISOString();
    const { ok, data } = await sbGet(
      `tello_staff_clock_entries?user_id=eq.${ctx.userId}&clock_in=lt.${cutoff}&or=(in_photo.not.is.null,out_photo.not.is.null)&select=id,in_photo,out_photo&limit=50`,
      serviceKey);
    if (!ok || !Array.isArray(data) || !data.length) return;
    const paths = [];
    data.forEach((r) => { if (r.in_photo) paths.push(r.in_photo); if (r.out_photo) paths.push(r.out_photo); });
    await deletePhotos(paths, serviceKey);
    await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_clock_entries?id=in.(${data.map((r) => r.id).join(',')})&user_id=eq.${ctx.userId}`, {
      method: 'PATCH',
      headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ in_photo: null, out_photo: null }),
    });
  } catch { /* retention is best-effort; it retries on the next punch */ }
}

// ---- staff sign-in: employee number + PIN → short-lived signed session ----
// Staff have no Supabase login. The clock page signs them in here and gets a
// session token signed (HMAC-SHA256) with a key derived from the service role
// key, so no extra Cloudflare setting is needed. The token only says "this
// staff member, for this admin" and expires; it can do nothing but use the
// clock and read that person's own schedule.
const SESSION_HOURS = 16;
const MAX_FAILED_PINS = 5;
const LOCK_MINUTES = 15;
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

const enc = new TextEncoder();
function b64url(buf) {
  let s = '';
  new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function hmacKey(serviceKey, usage) {
  return crypto.subtle.importKey('raw', enc.encode(`tello-clock-session:${serviceKey}`), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
async function signSession(payload, serviceKey) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(serviceKey, 'sign'), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}
async function readSession(token, serviceKey) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(serviceKey, 'verify'), b64urlToBytes(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!p || !p.u || !p.s || !(p.exp > Date.now())) return null;
    return p;
  } catch { return null; }
}

async function hashPin(pin, saltB64) {
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64urlToBytes(saltB64), iterations: 100000 }, keyMat, 256);
  return b64url(bits);
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function handleLogin(body, env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const empNo = typeof body.empNo === 'string' ? body.empNo.trim().slice(0, 20) : '';
  const staffIdIn = typeof body.staffId === 'string' ? body.staffId.trim().slice(0, 64) : '';
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  const BAD = json({ error: 'That PIN is not right.' }, 401);
  if (!KEY_RE.test(key)) return json({ error: 'This clock link is missing its company key. Ask your admin for the Tello Staff clock link.' }, 400);
  if ((!empNo && !staffIdIn) || !/^\d{4}$/.test(pin)) return BAD;

  const { ok: cfgOk, data: cfg } = await sbGet(`tello_staff_config?clock_key=eq.${key}&select=user_id`, serviceKey);
  if (!cfgOk) return json({ error: 'The time clock is not set up yet. The admin needs to run schema_clock_v3.sql in Supabase.' }, 500);
  const userId = Array.isArray(cfg) && cfg[0] ? cfg[0].user_id : null;
  let cred = null;
  if (userId && staffIdIn) {
    // Picked from the name list.
    const { data } = await sbGet(`tello_staff_clock_credentials?user_id=eq.${userId}&staff_id=eq.${encodeURIComponent(staffIdIn)}&select=*`, serviceKey);
    cred = Array.isArray(data) && data[0] ? data[0] : null;
  } else if (userId) {
    const { data } = await sbGet(`tello_staff_clock_credentials?user_id=eq.${userId}&emp_no=ilike.${encodeURIComponent(empNo.replace(/[%*_,()]/g, ''))}&select=*`, serviceKey);
    cred = Array.isArray(data) ? data.find((r) => r.emp_no.toLowerCase() === empNo.toLowerCase()) || null : null;
  }
  const now = new Date();
  if (cred && cred.locked_until && new Date(cred.locked_until) > now) {
    const mins = Math.ceil((new Date(cred.locked_until) - now) / 60000);
    return json({ error: `Too many wrong tries. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask your admin to reset your PIN.` }, 429);
  }
  // Same work whether or not the employee number exists, so timing doesn't reveal it.
  const salt = cred && cred.pin_salt ? cred.pin_salt : b64url(new Uint8Array(16));
  const hash = await hashPin(pin, salt);
  const good = !!(cred && cred.pin_hash && sameString(hash, cred.pin_hash));
  if (!good) {
    if (cred) {
      const failed = (cred.failed_count || 0) + 1;
      const patch = failed >= MAX_FAILED_PINS
        ? { failed_count: 0, locked_until: new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString() }
        : { failed_count: failed };
      await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_clock_credentials?user_id=eq.${userId}&staff_id=eq.${encodeURIComponent(cred.staff_id)}`, {
        method: 'PATCH',
        headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify(patch),
      });
    }
    return BAD;
  }
  if (cred.failed_count || cred.locked_until) {
    await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_clock_credentials?user_id=eq.${userId}&staff_id=eq.${encodeURIComponent(cred.staff_id)}`, {
      method: 'PATCH',
      headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ failed_count: 0, locked_until: null }),
    });
  }
  const session = await signSession({ u: userId, s: cred.staff_id, exp: now.getTime() + SESSION_HOURS * 3600000 }, serviceKey);
  const ctx = await loadContext(session, serviceKey);
  if (ctx.error) return ctx.error;
  return stateResponse(ctx, now, serviceKey, { session, notice: 'signed_in' });
}

// Names for the "tap your name" list: only people the admin has given a PIN.
// Anyone who has this company's clock link can see these names, like the list
// on a wall tablet — the PIN (5 wrong tries = locked 15 minutes) protects the
// clock itself.
async function handleRoster(body, env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!KEY_RE.test(key)) return json({ error: 'This clock link is missing its company key. Ask your admin for the Tello Staff clock link.' }, 400);
  const { ok, data: cfg } = await sbGet(`tello_staff_config?clock_key=eq.${key}&select=user_id`, serviceKey);
  if (!ok) return json({ error: 'The time clock is not set up yet. The admin needs to run schema_clock_v3.sql in Supabase.' }, 500);
  const userId = Array.isArray(cfg) && cfg[0] ? cfg[0].user_id : null;
  if (!userId) return json({ error: 'This clock link is not valid. Ask your admin for the Tello Staff clock link.' }, 404);
  const { data: creds } = await sbGet(`tello_staff_clock_credentials?user_id=eq.${userId}&pin_hash=not.is.null&select=staff_id`, serviceKey);
  const allowed = new Set((Array.isArray(creds) ? creds : []).map((c) => c.staff_id));
  const { data: members } = await sbGet(`tello_staff_members?user_id=eq.${userId}&select=id,name&order=name`, serviceKey);
  const staff = (Array.isArray(members) ? members : []).filter((m) => allowed.has(m.id)).map((m) => ({ id: m.id, name: m.name }));
  return json({ staff });
}

function publicEntry(e) {
  const c = { ...e };
  PRIVATE_ENTRY_FIELDS.forEach((f) => { delete c[f]; });
  return c;
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
async function loadContext(sessionToken, serviceKey) {
  const sess = await readSession(sessionToken, serviceKey);
  if (!sess) return { error: json({ error: 'Please sign in again.', code: 'signin_required' }, 401) };
  const link = { user_id: sess.u, staff_id: sess.s };
  const { ok: staffOk, data: staffRows } = await sbGet(
    `tello_staff_members?id=eq.${encodeURIComponent(link.staff_id)}&user_id=eq.${link.user_id}&select=name`, serviceKey);
  if (!staffOk) {
    return { error: json({ error: `The server could not read the staff list (database answered). The SUPABASE_SERVICE_ROLE_KEY setting in Cloudflare is probably missing or from a different Supabase project.` }, 500) };
  }
  if (!Array.isArray(staffRows) || !staffRows.length) {
    return { error: json({ error: 'Please sign in again.', code: 'signin_required' }, 401) };
  }
  const { data: cfgRows } = await sbGet(`tello_staff_config?user_id=eq.${link.user_id}&select=homes,clock_settings`, serviceKey);
  const cfg = Array.isArray(cfgRows) && cfgRows[0] ? cfgRows[0] : { homes: [], clock_settings: null };
  const { ok: consentOk, data: consentRows } = await sbGet(
    `tello_staff_clock_consent?user_id=eq.${link.user_id}&staff_id=eq.${encodeURIComponent(link.staff_id)}&consent_version=eq.${CONSENT_VERSION}&select=consented_at`,
    serviceKey);
  if (!consentOk) {
    return { error: json({ error: 'The photo and location check is not set up yet. The admin needs to run schema_clock_v2.sql in Supabase.' }, 500) };
  }
  return {
    userId: link.user_id,
    staffId: link.staff_id,
    staffName: staffRows[0].name,
    homes: cfg.homes || [],
    settings: cleanSettings(cfg.clock_settings),
    consented: Array.isArray(consentRows) && consentRows.length > 0,
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
    open: open ? publicEntry(open) : null,
    entries: entries.map(publicEntry),
    consented: !!ctx.consented,
    consentVersion: CONSENT_VERSION,
    // Tells the page whether to ask the phone for its location at a punch.
    locationRequired: ctx.homes.some((h) => validGeo(h.geo)),
    photoDays: PHOTO_DAYS,
    ...extra,
  });
}

async function handleGet({ request, env }) {
  const token = bearer(request);
  if (!token) return json({ error: 'Please sign in.', code: 'signin_required' }, 401);
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

async function handlePost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const action = body?.action;
  if (!['login', 'roster', 'consent', 'in', 'break_start', 'break_end', 'out'].includes(action)) return json({ error: 'Unknown action' }, 400);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' }, 500);
  if (action === 'login') return handleLogin(body, env);
  if (action === 'roster') return handleRoster(body, env);
  const token = bearer(request);
  if (!token) return json({ error: 'Please sign in.', code: 'signin_required' }, 401);

  const ctx = await loadContext(token, serviceKey);
  if (ctx.error) return ctx.error;
  const now = new Date();
  const nowIso = now.toISOString();

  // The person accepts the photo + location notice once (per notice version).
  if (action === 'consent') {
    if (body.version !== CONSENT_VERSION) return json({ error: 'The notice was updated. Reload this page and try again.' }, 409);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_clock_consent?on_conflict=user_id,staff_id,consent_version`, {
      method: 'POST',
      headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify({ user_id: ctx.userId, staff_id: ctx.staffId, consent_version: CONSENT_VERSION }),
    });
    if (!res.ok) return json({ error: 'Could not save your answer. Try again in a moment.' }, 500);
    ctx.consented = true;
    return stateResponse(ctx, now, serviceKey, { notice: 'consented' });
  }

  const { open } = await loadEntries(ctx, now, serviceKey);
  const needsProof = action === 'in' || (action === 'out' && open);
  if (needsProof && !ctx.consented) {
    return json({ error: 'Please read and accept the photo and location notice first.', code: 'consent_required' }, 403);
  }
  const cleanup = () => {
    const job = purgeOldPhotos(ctx, now, serviceKey);
    if (typeof context.waitUntil === 'function') context.waitUntil(job);
    return job;
  };

  if (action === 'in') {
    if (open) return stateResponse(ctx, now, serviceKey, { notice: 'already_in' });
    const photo = decodePhoto(body.photo);
    if (!photo) return json({ error: 'A photo is needed to clock in. Please try again.', code: 'photo_required' }, 400);
    // Attach the scheduled shift this punch most plausibly belongs to.
    const shifts = await loadShifts(ctx, now, serviceKey);
    const t = now.getTime();
    const match = shifts.find((s) => t >= new Date(s.start).getTime() - 60 * 60000 && t <= new Date(s.end).getTime() + 2 * 3600000);
    const pos = readPosition(body.position);
    const loc = checkLocation(ctx, pos, match ? match.homeName : null, 'in');
    if (loc.error) return json({ error: loc.message, code: loc.error }, 403);

    const entryId = crypto.randomUUID();
    const photoPath = `${ctx.userId}/${entryId}-in.jpg`;
    if (!(await putPhoto(photoPath, photo, serviceKey))) {
      return json({ error: 'Could not save your photo. Try again in a moment.' }, 500);
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_clock_entries`, {
      method: 'POST',
      headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        id: entryId,
        user_id: ctx.userId,
        staff_id: ctx.staffId,
        staff_name: ctx.staffName,
        home_name: match ? match.homeName : null,
        sched_start: match ? match.start : null,
        sched_end: match ? match.end : null,
        clock_in: nowIso,
        orig_clock_in: nowIso,
        breaks: [],
        in_photo: photoPath,
        // Location is only kept when it was actually checked.
        ...(loc.enforced ? { in_lat: pos.lat, in_lng: pos.lng, in_accuracy_m: pos.accuracy, in_distance_m: Math.round(loc.dist) } : {}),
      }),
    });
    if (!res.ok) {
      await deletePhotos([photoPath], serviceKey).catch(() => {});
      // The one-open-entry-per-person index turns a double tap into a conflict.
      if (res.status === 409) return stateResponse(ctx, now, serviceKey, { notice: 'already_in' });
      return json({ error: 'Could not clock in. Try again in a moment.' }, 500);
    }
    await cleanup();
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
      return json({ error: 'Could not start the break. Try again.' }, 500);
    }
    return stateResponse(ctx, now, serviceKey, { notice: 'break_started' });
  }

  if (action === 'break_end') {
    if (!openBreak) return stateResponse(ctx, now, serviceKey, { notice: 'not_on_break' });
    const next = breaks.map((b) => (b === openBreak ? { ...b, end: nowIso } : b));
    if (!(await patchEntry(open.id, ctx.userId, { breaks: next }, serviceKey))) {
      return json({ error: 'Could not end the break. Try again.' }, 500);
    }
    return stateResponse(ctx, now, serviceKey, { notice: 'break_ended' });
  }

  // out
  if (openBreak) return json({ error: 'End your break first, then clock out.' }, 409);
  const photo = decodePhoto(body.photo);
  if (!photo) return json({ error: 'A photo is needed to clock out. Please try again.', code: 'photo_required' }, 400);
  const pos = readPosition(body.position);
  const loc = checkLocation(ctx, pos, open.home_name, 'out');
  if (loc.error) return json({ error: loc.message, code: loc.error }, 403);
  const photoPath = `${ctx.userId}/${open.id}-out.jpg`;
  if (!(await putPhoto(photoPath, photo, serviceKey))) {
    return json({ error: 'Could not save your photo. Try again in a moment.' }, 500);
  }
  const patch = {
    clock_out: nowIso,
    orig_clock_out: nowIso,
    out_photo: photoPath,
    ...(loc.enforced ? { out_lat: pos.lat, out_lng: pos.lng, out_accuracy_m: pos.accuracy, out_distance_m: Math.round(loc.dist) } : {}),
  };
  if (!(await patchEntry(open.id, ctx.userId, patch, serviceKey))) {
    await deletePhotos([photoPath], serviceKey).catch(() => {});
    return json({ error: 'Could not clock out. Try again.' }, 500);
  }
  await cleanup();
  return stateResponse(ctx, now, serviceKey, { notice: 'clocked_out' });
}

// Any unexpected crash comes back as JSON with the reason, never a bare HTML error page.
export async function onRequestGet(ctx) {
  try {
    return await handleGet(ctx);
  } catch (err) {
    return json({ error: `Server error: ${err && err.message ? err.message : err}` }, 500);
  }
}
export async function onRequestPost(ctx) {
  try {
    return await handlePost(ctx);
  } catch (err) {
    return json({ error: `Server error: ${err && err.message ? err.message : err}` }, 500);
  }
}
