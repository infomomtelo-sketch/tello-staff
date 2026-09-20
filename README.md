# tello-staff

**Tello Staff** — care home staff operations app. A separate, standalone tool
from the Tello AI advisor (`tello.html` / `tello-runp8`): this app is for
day-to-day scheduling and shift operations.

Static site plus a few Cloudflare Pages Functions for the AI chat endpoint
and the public share pages — no client-side build step, matching the other
RunP8 apps.

## Site structure

- `/index.html`, `/about.html`, `/privacy.html`, `/terms.html` — the public
  marketing site (no login required). Shared styling in `/marketing.css`.
- `/app/index.html` — the actual Tello Staff application (everything below).
  Sign-in links throughout the marketing site point at `/app/`.
- `/share.html` — the public, unauthenticated per-home schedule page a
  caregiver opens from a link the admin generates (see Share Links below).
- `/my-shift.html` — the public, unauthenticated personal "where + what time
  do I work" page a staff member opens from their own link (see My-Shift
  Links below).
- `/functions/api/chat.js` — the Chat tab's backend, served at `/api/chat`
  regardless of which page calls it.
- `/functions/api/share-data.js`, `/functions/api/share-request.js` — power
  `/share.html`: validate the link token and read/write schedule data and
  requests using the Supabase **service role** key (bypasses RLS), so the
  rest of the database stays locked down to the signed-in admin only.
- `/functions/api/staff-share-data.js` — powers `/my-shift.html` the same
  way: token-validated, service-role key, no RLS changes.

## What's built (in `/app/`)

- **Schedule Board** — configurable homes (default 8), one selected at a time,
  each with a free-text "Working" and "Day Off" list per day (any number of
  names — type "Manpreet (N)" for a night shift, "Nelia (T)" for a trainee,
  whatever notation you already use) instead of fixed slots, matching how the
  schedule is actually kept on paper. Week view (Mon–Sun) for quick edits,
  Month view (Sunday-first, like a wall calendar) for the printable page that
  actually goes up on the board. An 11-slot reliever pool floats alongside it
  as its own always-current-week grid.
- **Optional shift times** — still the same free-text box, nothing new to
  learn or fill in: type a time after a name (e.g. "Peter, 7am-3pm" or
  "Divina 15:00-23:00") and it's recognized as an actual shift time rather
  than just more text. A name with no time still works exactly as before
  (including the existing "Manpreet (N)" / "Nelia (T)" style notes — those
  aren't mistaken for times). Saved alongside the raw text as structured
  `working_shifts` data (one `{name, start, end}` per line), so Chat can
  answer a "what time does X work" question correctly, and both "Ask Tello
  to Fill" features carry a person's usual time forward if their history
  shows one consistently. This is what the My-Shift Links below read to
  answer "where and what time do I work today."
- **All Homes view** (third toggle on the Schedule Board, next to Week/Month)
  — a master roster for one date: every home listed with its Working and Day
  Off boxes in a single screen, so the admin can fill a whole day across all
  homes in one pass instead of switching homes one at a time. Step forward/
  back a day with ‹ ›, or jump back to today. Same underlying
  `tello_staff_schedule_days` rows as the per-home Week/Month grids — nothing
  typed here is separate data, it just shows up immediately when you switch
  back to that home's own Week or Month view. Mirrors the paper workflow of
  keeping one "Relievers Monthly Schedule" master sheet that per-home printed
  pages get filtered from.
- **"✨ Ask Tello to Fill This Day"** (All Homes view) — one tap asks Tello to
  guess the whole day's roster from the last 3 weeks of that home's history
  (who's usually paired, who's normally off that weekday) plus the Staff
  directory, so she isn't retyping the same names into every box every day.
  It only fills boxes that are still blank — anything already typed for that
  date is left alone and reported as skipped — and only uses names it's
  actually seen, leaving a home blank rather than guessing when the history's
  too thin. Filled boxes get a gold outline and a one-line "why" note per
  home so she can sanity-check the pick at a glance; a filled box loses the
  outline the moment she clicks into it. One "↩ Undo Tello's Fill" clears
  exactly what that suggestion filled (never anything typed since) — it goes
  away when you navigate to a different date. Saves through the exact same
  path as typing it by hand, so it's not a separate "pending" state sitting
  outside the database. Backed by a new `/api/suggest-day` Function, same
  pattern and same `ANTHROPIC_API_KEY` as Chat.
- **"✨ Ask Tello to Fill All Homes This Month"** (Month view) — the real
  workflow is a month done in one pass, not typed in day by day, so this
  does the same thing as the daily suggestion but for every day of the
  month you're viewing, across every home, in one click. Confirms first
  (it's a much bigger write than a single day), then calls a new
  `/api/suggest-month` Function once per home — one small request per home
  rather than one call for the whole thing or one call per day — each
  returning that home's whole month plus a one-line summary of the pattern
  it used. Same "only fill blank boxes, never guess a name it hasn't
  actually seen" rule as the daily version. Writes straight to Supabase as
  it goes (there's no single on-screen grid showing every home's whole
  month at once to fill into the way there is for one day), so unlike the
  daily suggestion the calendar refreshes automatically once every home is
  done. A running fill shows "Home 3 of 8…" progress and keeps going even
  if you navigate elsewhere; one "↩ Undo This Month's Fill" clears exactly
  what that run wrote, and both the result summary and the undo option are
  scoped to the month they came from — switching months hides them rather
  than misattributing them to whatever month you're now looking at.
- **Today's Board** — today's date, a rotating caregiver quote-of-the-day
  (same quote all day, changes at midnight, no setup needed), admin-added
  reminder cards (title, note, due time), manually-entered staff birthdays,
  and a shift summary pulled live from the Schedule Board.
- **Chat** — ask Tello about coverage, gaps, or who's free. Every request is
  grounded in the current week's Schedule Board data, open reminders, and
  upcoming birthdays (built fresh client-side and sent as context on each
  message). Conversation history persists in Supabase.
- **Staff** — a directory: add/edit/remove staff members (name, role, phone,
  assigned home, notes), all inline-editable. No logins or role-based access
  yet — same single-admin model as the rest of the app. Assigning a home to a
  staff member only sets a directory reference; it does not put them on the
  schedule automatically (the Schedule Board is deliberately free text — see
  next bullet for how the two connect).
- **Schedule Board ↔ Staff directory link** — the Schedule Board shows a
  "Staff assigned to this home" chip strip (pulled from the Staff tab's
  per-person home field) above the grid. Click into a Working box, then tap
  a chip to append that name — still plain text under the hood, just saves
  retyping. The two systems otherwise stay independent by design (the
  schedule accepts anyone, typed exactly as needed, not only directory
  names).
- **"👥 Staff" drag panel** (Schedule Board toolbar, every view) — a second,
  broader way to place names: opens a panel listing *every* staff member
  (not just people assigned to the home you're currently viewing, since a
  reliever covering there might not be), each as a tile you drag straight
  onto any Working or Day Off box — no need to click into the box first.
  Dropping shows a dashed gold outline on the box you're over, then appends
  the name (same as the chip strip) once you let go. Built on Pointer
  Events rather than the HTML5 drag-and-drop API, since native HTML5 DnD
  doesn't fire from a touch gesture on iOS/Android — this way the same code
  drives both a mouse drag and a finger drag on a phone. A tap on a tile
  with no real drag still falls back to the older "insert into whatever box
  you last clicked into" behavior, so nothing about the existing chip strip
  changes.
- **Share Links** (Schedule Board → Manage) — generate a per-home, no-login
  link to `/share.html` showing that home's current-week schedule and the
  reliever pool read-only, plus a "Request a change" form (the form shows
  the days-off policy up front: requests due by the end of the month
  *before* the time off, e.g. a November day off by October 31). Revoke a
  link any time to cut off access immediately. Submitted requests show up
  as a **Requests** card on Today's Board (re-fetched fresh on every visit,
  so a request submitted while you're mid-session still shows up) — a date-
  specific request submitted past that deadline gets a **Late** badge — with
  a one-click "Mark Handled." Approving doesn't touch the Schedule Board
  automatically, you still go update the shift yourself.
- **My-Shift Links** (Staff tab, per person) — the personal counterpart to
  Share Links: a no-login link to `/my-shift.html` showing that one staff
  member's own working days and days off for a whole calendar month (‹ ›
  to flip months), matching the month-at-a-time way the schedule itself
  actually gets filled in rather than a short day-by-day lookahead. A
  "Today: Working at [Home], 7am–3pm" (or "You're off" / "Not scheduled
  yet") card sits on top when viewing the current month, and today's row is
  highlighted in the list below it. So a caregiver can check where and when
  to show up — for today or for the rest of the month — without calling the
  admin. Text or bookmark it to them once; revoke any time. It works by
  scanning every home's Working/Day Off text for an exact (case-insensitive)
  match on that person's directory name — there's no real link between a
  staff row and a schedule entry, so it's only as reliable as the schedule
  using that same spelling (typing it via the assigned-staff chips, rather
  than a nickname or typo, keeps it matching). Shares the same
  `tello_staff_share_links` table and revoke/copy code as home Share Links,
  just keyed by `staff_id` instead of `home_id`.
- **Chat knows the staffing pattern** — Tello's context now includes that
  each home runs two main caregivers with a reliever normally covering
  about two days when one is off, and the days-off deadline policy, so its
  coverage suggestions and answers about request timing match how staffing
  actually works here rather than generic assumptions.
- Bottom nav: **Schedule**, **Today**, **Staff**, **Chat**.
- Auth: Supabase email/password sign in, sign up, and password reset.
- Light/dark background toggle (☀️/🌙 button, top right) — defaults to the
  dark green theme, remembers the choice per browser via `localStorage`.

## Setup

### 1. Database (Supabase project `nwlhsshvqmbhemhxcran`)

Paste `schema.sql` into the Supabase SQL editor and run it. It creates eight
tables (`tello_staff_config`, `tello_staff_schedule_days`,
`tello_staff_reminders`, `tello_staff_birthdays`, `tello_staff_chat_messages`,
`tello_staff_members`, `tello_staff_share_links`, `tello_staff_requests`),
each with RLS scoped to `auth.uid()`, and is safe to re-run. If you ran an
earlier version of this schema, `tello_staff_schedule_days` (day-by-day) is
new and replaces the old `tello_staff_schedule` (one JSONB blob per week) —
the script leaves the old table alone since it doesn't know whether it holds
data you still want; drop it yourself once you've checked. If you ran the
schema before `working_shifts` existed, re-running it now adds that column
in place via `alter table ... add column if not exists` — no data loss. Same
for `tello_staff_share_links.staff_id` (added for My-Shift Links): re-running
relaxes `home_id` to nullable and adds `staff_id` plus a check constraint
requiring exactly one of the two — existing home-link rows are unaffected.

Note: `tello_staff_share_links` and `tello_staff_requests` intentionally have
**no public RLS policy** — only the owning admin can read/write them directly.
The public share pages never talk to Supabase directly; they go through the
Functions below, which use the service role key to bypass RLS in a
controlled way (token-checked, not identity-checked).

### 2. Fill in the anon key

Open `app/index.html` and set `SUPABASE_ANON_KEY` (Supabase → Project
Settings → API → anon public key) — it ships with a placeholder that will
not authenticate anyone until replaced.

### 3. Anthropic API key (for Chat and the "Ask Tello to Fill" suggestions)

`functions/api/chat.js`, `functions/api/suggest-day.js`, and
`functions/api/suggest-month.js` all call Claude server-side. In Cloudflare
Pages → Settings → Environment variables → Production, add:

```
ANTHROPIC_API_KEY = sk-ant-...     (type: Secret / Encrypted)
```

**No prefix** — this must NOT be named `VITE_ANTHROPIC_API_KEY` or similar;
a prefixed var would be a no-op here anyway since there's no build step to
inline it, but keep the naming clean. Without this var set, all three
features will show a clear "not configured on the server" error rather than
failing silently. All three functions currently call `claude-opus-5`; change
the `MODEL` constant at the top of each file to `claude-sonnet-5` or
`claude-haiku-4-5` for a cheaper/faster tier if Opus-level reasoning isn't
needed.

### 4. Supabase service role key (for share links)

`functions/api/share-data.js` and `functions/api/share-request.js` need
Supabase's **service role** key to serve the public `/share.html` page
without a login. In Cloudflare Pages → Settings → Environment variables →
Production, add:

```
SUPABASE_SERVICE_ROLE_KEY = eyJ...     (type: Secret / Encrypted)
```

Get it from Supabase → Project Settings → API → **service_role** secret key
(a different key from the anon key already in `app/index.html` — the service
role key bypasses row-level security entirely, so treat it like a master
password: Cloudflare Secret only, never in client-side code, never
committed). Without this var set, share links will 500 with a clear
"not configured on the server" error rather than failing silently — Share
Links can be created in the app regardless, they just won't resolve until
this is set.

### 5. Cloudflare Pages

- Project: `carehome-application-form`, deployed at
  `https://carehome-application-form.pages.dev`.
- **`title22.app` / `title-22.com` are NOT this app** — they belong to a
  separate, already-live product ("Title22," a Title 22 compliance/
  inspection tracker for RCFE/ARF facilities). Do not point this Pages
  project's custom domain at either — that would overwrite the other live
  site. If Tello Staff ever gets its own custom domain, update
  `REDIRECT_URL` below and the Supabase redirect URL list to match; until
  then the `*.pages.dev` URL is correct.
- Production branch must be set to `claude/tello-staff-index-hn4amu` —
  `main` currently carries a different, unrelated in-progress rewrite of
  this app from another session.
- Connect this repo, no build command, output directory = repo root.
  Cloudflare Pages auto-detects everything under `functions/api/` and
  deploys it alongside the static site — no separate Worker to set up.
- `REDIRECT_URL` in `app/index.html` is hardcoded to
  `https://carehome-application-form.pages.dev/app/` to match. If it changes,
  add the new URL to Supabase → Authentication → URL Configuration →
  Redirect URLs (the old one can be removed from that list once nothing
  points at it).

## Notes

- All data is scoped per signed-in user via Supabase RLS — one admin account
  today, matching the current single-user usage.
- Reliever pool "slots" are just a nameable roster with their own always-
  current-week grid — type where a reliever is deployed into any cell.
- Month view only exists for the selected home's calendar; the reliever pool
  stays week-only since it's a short-horizon floating resource, not something
  browsed by month.
- Chat doesn't read the Staff directory yet — its context is still built only
  from the Schedule Board, reminders, and birthdays, so it only knows names
  as they appear typed into the Schedule Board.
- `privacy.html` and `terms.html` are starting-point templates, not legal
  advice — each page says so up front. Have them reviewed before relying on
  them, especially given the Title 22 regulatory context.
