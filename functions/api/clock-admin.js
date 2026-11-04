// Cloudflare Pages Function — POST /api/clock-admin
// Lets the signed-in ADMIN set up staff sign-in for the Tello Staff clock:
//   { action: 'set_pin',   staffId, pin?, empNo? }  → set/reset a PIN (random 4 digits if pin omitted)
//   { action: 'set_emp',   staffId, empNo }         → change the employee number only
//   { action: 'clear_pin', staffId }                → turn that person's sign-in off
// The admin's Supabase session token (Authorization: Bearer ...) is verified
// with Supabase Auth here; PINs are hashed on the server (PBKDF2-SHA256 with a
// random salt) and the plain PIN is never stored. A PIN is returned to the admin
// only when this function generated it, so it can be told to the staff member.

const SUPABASE_URL = 'https://nwlhsshvqmbhemhxcran.supabase.co';
const enc = new TextEncoder();

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
function b64url(buf) {
  let s = '';
  new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function hashPin(pin, saltB64) {
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64urlToBytes(saltB64), iterations: 100000 }, keyMat, 256);
  return b64url(bits);
}
function randomPin() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 10000).padStart(4, '0');
}

// The admin's user id, from their Supabase session token.
async function adminId(request, serviceKey) {
  const h = request.headers.get('Authorization') || '';
  const jwt = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!jwt) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return u && u.id ? u.id : null;
}

async function nextEmpNo(userId, serviceKey) {
  const { data } = await sbGet(`tello_staff_clock_credentials?user_id=eq.${userId}&select=emp_no`, serviceKey);
  const used = new Set((Array.isArray(data) ? data : []).map((r) => String(r.emp_no).toLowerCase()));
  let n = 1001;
  while (used.has(String(n))) n += 1;
  return String(n);
}

async function handle({ request, env }) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' }, 500);
  const userId = await adminId(request, serviceKey);
  if (!userId) return json({ error: 'Please sign in again.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const { action } = body || {};
  if (!['set_pin', 'set_emp', 'clear_pin'].includes(action)) return json({ error: 'Unknown action' }, 400);
  const staffId = typeof body.staffId === 'string' ? body.staffId : '';

  const { ok: staffOk, data: staffRows } = await sbGet(
    `tello_staff_members?id=eq.${encodeURIComponent(staffId)}&user_id=eq.${userId}&select=id,name`, serviceKey);
  if (!staffOk || !Array.isArray(staffRows) || !staffRows.length) return json({ error: 'That staff member was not found.' }, 404);

  const { data: credRows } = await sbGet(
    `tello_staff_clock_credentials?user_id=eq.${userId}&staff_id=eq.${encodeURIComponent(staffId)}&select=*`, serviceKey);
  const existing = Array.isArray(credRows) && credRows[0] ? credRows[0] : null;

  let empNo = existing ? existing.emp_no : null;
  if (typeof body.empNo === 'string' && body.empNo.trim()) {
    empNo = body.empNo.trim();
    if (!/^[A-Za-z0-9-]{1,12}$/.test(empNo)) return json({ error: 'Employee numbers can use letters, numbers and dashes, up to 12 characters.' }, 400);
  }
  if (!empNo) empNo = await nextEmpNo(userId, serviceKey);

  const row = { user_id: userId, staff_id: staffId, emp_no: empNo, updated_at: new Date().toISOString() };
  let generatedPin = null;
  if (action === 'set_pin') {
    let pin = typeof body.pin === 'string' ? body.pin.trim() : '';
    if (pin) {
      if (!/^\d{4}$/.test(pin)) return json({ error: 'A PIN is exactly 4 digits.' }, 400);
    } else {
      pin = randomPin();
      generatedPin = pin;
    }
    const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    row.pin_salt = salt;
    row.pin_hash = await hashPin(pin, salt);
    row.failed_count = 0;
    row.locked_until = null;
  } else if (action === 'clear_pin') {
    row.pin_salt = null;
    row.pin_hash = null;
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/tello_staff_clock_credentials?on_conflict=user_id,staff_id`, {
    method: 'POST',
    headers: sbHeaders(serviceKey, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    if (res.status === 409) return json({ error: 'That employee number is already used by someone else.' }, 409);
    return json({ error: 'Could not save. If this keeps happening, check that schema_clock_v3.sql has been run in Supabase.' }, 500);
  }
  return json({ ok: true, staffId, empNo, ...(generatedPin ? { pin: generatedPin } : {}) });
}

export async function onRequestPost(ctx) {
  try {
    return await handle(ctx);
  } catch (err) {
    return json({ error: `Server error: ${err && err.message ? err.message : err}` }, 500);
  }
}
