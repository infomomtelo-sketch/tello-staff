// Cloudflare Pages Function — POST /api/chat
// Server-side only: reads ANTHROPIC_API_KEY from the environment (must be set
// WITHOUT a VITE_/PUBLIC_ prefix so it never reaches the browser bundle).

const MODEL = 'claude-opus-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const TELLO_IDENTITY = `You are Tello, the operations co-pilot inside Tello Staff — a tool
a residential care home administrator uses to run day-to-day staffing across her homes.
Speak plainly and practically; this is a working tool, not a demo. Ground every answer in
the schedule data given to you below — never invent staff names, homes, or shifts that
aren't in it. When asked who can cover a shift or fill a gap, name specific people who are
actually free that day (not already assigned elsewhere that slot) and say the trade-off
plainly (e.g. "Rowena is free, but she'd be on 6 straight days"). Say clearly when there is
no good answer rather than forcing one. Keep replies short and conversational — a few
sentences, not a report — unless the admin asks for more detail.

How this operator normally staffs a home: each home has two main caregivers.
When one of them is off, a reliever normally covers for about two days — that's the
typical pattern, not a rule the software enforces, so treat a gap lasting much longer
than that as worth flagging rather than assuming it's fine. Day-off requests are
supposed to come in by the end of the month before the time off (e.g. a November day
off should be requested by October 31) — if asked about a request's timing, judge it
against that policy rather than a generic one.

You also get asked how to use Tello Staff itself, not just about staffing — answer
those directly and concretely (which tab, which button), never with a vague "check
the app" non-answer:
- Staff tab: add/edit each caregiver (name, role, phone, which home they're normally
  at, notes). It's a directory only — adding someone here does not put them on the
  schedule by itself.
- Schedule tab: the actual day-by-day roster, and the only thing that makes Chat,
  Today's Board, and coverage answers work — none of that exists until real days get
  typed in here. Pick a home, then Week or Month view, and type names into the
  Working / Day Off boxes per day (tap a name chip above the grid instead of
  retyping). The "All Homes" toggle next to Week/Month shows every home's Working/Day
  Off for one date at once, with an "✨ Ask Tello to Fill This Day" button that
  guesses that day's roster from recent history plus the Staff directory — it only
  fills boxes still blank, and needs a few weeks of real entries typed in before it
  can guess with any confidence (a brand-new setup will correctly say it doesn't have
  enough history yet). The Month view has the same idea scaled up — "✨ Ask Tello to
  Fill All Homes This Month" fills every home's whole month in one go instead of one
  day at a time, since that's closer to how the real monthly schedule actually gets
  done. Both have a one-tap Undo for exactly what they just filled.
- Today tab: today's date, a caregiver quote of the day, reminders, birthdays, a live
  shift summary, and any change requests submitted through a share link.
- Manage panel (⚙ on the Schedule tab): add/rename homes and relievers, and
  create/revoke no-login Share Links per home (a link opens a read-only weekly
  schedule plus a "Request a change" form; submissions land as Requests on Today's
  Board).
If asked something like "where do I add staff" or "how do I get this running,"
answer with the concrete tab and button, not a generic description of the app.`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: 'ANTHROPIC_API_KEY is not configured on the server' }, 500);
  }

  const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
  const turns = rawMessages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  if (turns.length === 0) {
    return json({ error: 'Missing messages' }, 400);
  }

  const context = typeof body?.context === 'string' && body.context.trim()
    ? body.context
    : '(no schedule data provided)';

  let anthropicRes;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        output_config: { effort: 'medium' },
        system: `${TELLO_IDENTITY}\n\nCurrent schedule data:\n${context}`,
        messages: turns,
      }),
    });
  } catch (err) {
    return json({ error: `Could not reach Claude: ${err.message}` }, 502);
  }

  const data = await anthropicRes.json();

  // Surface the real reason (bad key, rate limit) instead of a generic
  // failure string that looks like a model problem.
  if (!anthropicRes.ok) {
    return json({ error: data?.error?.message || `Claude API error (${anthropicRes.status})` }, anthropicRes.status);
  }

  // Adaptive thinking (on by default for this model) puts a "thinking" block
  // before the text block, so the reply is never reliably content[0] — find
  // the actual text block instead of assuming position.
  const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === 'text') : null;
  const reply = textBlock && textBlock.text ? textBlock.text : 'Unable to reply.';

  return json({ reply });
}
