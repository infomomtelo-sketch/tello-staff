# tello-staff

**Tello Staff** — care home staff operations app. A separate, standalone tool
from the Tello AI advisor (`tello.html` / `tello-runp8`): this app is for
day-to-day scheduling and shift operations.

Static site (`index.html`) plus one Cloudflare Pages Function for the AI
chat endpoint — no client-side build step, matching the other RunP8 apps.

## What's built

- **Schedule Board** — configurable homes (default 8), one selected at a time,
  each with a free-text "Working" and "Day Off" list per day (any number of
  names — type "Manpreet (N)" for a night shift, "Nelia (T)" for a trainee,
  whatever notation you already use) instead of fixed slots, matching how the
  schedule is actually kept on paper. Week view (Mon–Sun) for quick edits,
  Month view (Sunday-first, like a wall calendar) for the printable page that
  actually goes up on the board. An 11-slot reliever pool floats alongside it
  as its own always-current-week grid.
- **Today's Board** — today's date, admin-added reminder cards (title, note,
  due time), manually-entered staff birthdays, and a shift summary pulled
  live from the Schedule Board.
- **Chat** — ask Tello about coverage, gaps, or who's free. Every request is
  grounded in the current week's Schedule Board data, open reminders, and
  upcoming birthdays (built fresh client-side and sent as context on each
  message). Conversation history persists in Supabase.
- **Staff** — still a placeholder, lands in a future session.
- Bottom nav: **Schedule**, **Today**, **Staff**, **Chat**.
- Auth: Supabase email/password sign in, sign up, and password reset.

## Setup

### 1. Database (Supabase project `nwlhsshvqmbhemhxcran`)

Paste `schema.sql` into the Supabase SQL editor and run it. It creates five
tables (`tello_staff_config`, `tello_staff_schedule_days`,
`tello_staff_reminders`, `tello_staff_birthdays`, `tello_staff_chat_messages`),
each with RLS scoped to `auth.uid()`, and is safe to re-run. If you ran an
earlier version of this schema, `tello_staff_schedule_days` (day-by-day) is
new and replaces the old `tello_staff_schedule` (one JSONB blob per week) —
the script leaves the old table alone since it doesn't know whether it holds
data you still want; drop it yourself once you've checked.

### 2. Fill in the anon key

Open `index.html` and set `SUPABASE_ANON_KEY` (Supabase → Project Settings →
API → anon public key) — it ships with a placeholder that will not
authenticate anyone until replaced.

### 3. Anthropic API key (for Chat)

`functions/api/chat.js` calls Claude server-side. In Cloudflare Pages →
Settings → Environment variables → Production, add:

```
ANTHROPIC_API_KEY = sk-ant-...     (type: Secret / Encrypted)
```

**No prefix** — this must NOT be named `VITE_ANTHROPIC_API_KEY` or similar;
a prefixed var would be a no-op here anyway since there's no build step to
inline it, but keep the naming clean. Without this var set, the Chat tab
will show a clear "not configured on the server" error rather than failing
silently. The function currently calls `claude-opus-5`; change the `MODEL`
constant at the top of `functions/api/chat.js` to `claude-sonnet-5` or
`claude-haiku-4-5` for a cheaper/faster tier if Opus-level reasoning isn't
needed for day-to-day coverage questions.

### 4. Cloudflare Pages

- Connect this repo, no build command, output directory = repo root.
  Cloudflare Pages auto-detects `functions/api/chat.js` and deploys it
  alongside the static site — no separate Worker to set up.
- Once you know the real production URL, update `REDIRECT_URL` in
  `index.html` to match exactly (currently hardcoded to the placeholder
  `https://tello-staff.pages.dev`) and add that same URL to Supabase →
  Authentication → URL Configuration → Redirect URLs.

## Notes

- All data is scoped per signed-in user via Supabase RLS — one admin account
  today, matching the current single-user usage.
- Reliever pool "slots" are just a nameable roster with their own always-
  current-week grid — type where a reliever is deployed into any cell.
- Month view only exists for the selected home's calendar; the reliever pool
  stays week-only since it's a short-horizon floating resource, not something
  browsed by month.
- Chat has no Staff directory to draw on yet (that's a future session), so it
  only knows names as they appear typed into the Schedule Board.
