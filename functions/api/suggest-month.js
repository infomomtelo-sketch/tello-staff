// Cloudflare Pages Function — POST /api/suggest-month
// Server-side only: reads ANTHROPIC_API_KEY from the environment, same
// pattern as /api/chat and /api/suggest-day. Given one home's recent history
// plus the staff directory, asks Claude to guess Working/Day Off for every
// day of a whole target month, so the client can fill a full month for that
// home in one call instead of one day at a time. The client calls this once
// per home to keep each request small and fast, and so one home failing
// doesn't block the rest.

const MODEL = 'claude-opus-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SUGGEST_MONTH_SYSTEM = `You are Tello, helping a residential care home administrator fill in a
month's staffing roster for one home at a time. You're given that home's recent history (who worked,
who was off) for the weeks right before the target month, the staff directory, and any days within the
target month that are already filled in — leave those exactly as they are, don't spend effort guessing
for them, the admin's system ignores whatever you say for those dates anyway.

This home normally runs two main caregivers. When one of them is off, a reliever normally covers for
about two days — that's the typical pattern, not a hard rule. Use it, and whatever weekday each day off
tends to repeat on, to project a believable rotation across the whole month.

Using ONLY names that already appear in the history or the staff directory given to you — never invent
a name — fill in Working and Day Off for every date you're given in the target month, except the ones
already marked as filled. If the history is too thin to guess confidently for a stretch of days, leave
those days' fields as empty strings rather than guessing wildly — an empty guess beats a wrong one.

Respond with ONLY valid JSON, no markdown code fences, no commentary before or after, in exactly this
shape:
{"days":[{"date":"YYYY-MM-DD","working":"Name1\\nName2","dayOff":"Name3"}],"summary":"one short clause, under 30 words, describing the pattern you used for this home"}
Include exactly one entry per date given, in the same order. Use \\n between multiple names in the same
field, matching how the history is formatted.`;

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

  const homeId = typeof body?.homeId === 'string' ? body.homeId : '';
  const homeName = typeof body?.homeName === 'string' ? body.homeName : '';
  const monthLabel = typeof body?.monthLabel === 'string' ? body.monthLabel : '';
  const dates = Array.isArray(body?.dates) ? body.dates.filter((x) => typeof x === 'string') : [];
  const existingDays = body?.existingDays && typeof body.existingDays === 'object' ? body.existingDays : {};
  const context = typeof body?.context === 'string' ? body.context.trim() : '';
  if (!homeId || !dates.length || !context) {
    return json({ error: 'Missing homeId, dates, or context' }, 400);
  }

  const existingLines = dates
    .filter((d) => existingDays[d] && (existingDays[d].working || existingDays[d].dayOff))
    .map((d) => `  ${d} — Working: ${existingDays[d].working || '(none)'}${existingDays[d].dayOff ? ` | Day off: ${existingDays[d].dayOff}` : ''}`);

  const userContent = [
    `Home: ${homeName} (id: ${homeId})`,
    `Target month: ${monthLabel}`,
    `Dates to fill, in order: ${dates.join(', ')}`,
    '',
    existingLines.length
      ? `ALREADY FILLED IN THIS MONTH (leave these as-is):\n${existingLines.join('\n')}`
      : 'ALREADY FILLED IN THIS MONTH: none yet.',
    '',
    context,
  ].join('\n');

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
        system: SUGGEST_MONTH_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (err) {
    return json({ error: `Could not reach Claude: ${err.message}` }, 502);
  }

  const data = await anthropicRes.json();

  if (!anthropicRes.ok) {
    return json({ error: data?.error?.message || `Claude API error (${anthropicRes.status})` }, anthropicRes.status);
  }

  // Adaptive thinking (on by default for this model) puts a "thinking" block
  // before the text block, so the reply is never reliably content[0].
  const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === 'text') : null;
  const raw = textBlock && textBlock.text ? textBlock.text.trim() : '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = null;
  }

  if (!parsed || !Array.isArray(parsed.days)) {
    return json({ error: "Tello couldn't put together a usable suggestion for this home — try again." }, 502);
  }

  const days = parsed.days
    .filter((d) => d && typeof d.date === 'string')
    .map((d) => ({
      date: d.date,
      working: typeof d.working === 'string' ? d.working : '',
      dayOff: typeof d.dayOff === 'string' ? d.dayOff : '',
    }));

  return json({ days, summary: typeof parsed.summary === 'string' ? parsed.summary : '' });
}
