// Cloudflare Pages Function — POST /api/suggest-day
// Server-side only: reads ANTHROPIC_API_KEY from the environment, same as
// /api/chat. Given recent per-home history and the staff directory, asks
// Claude to guess a full day's Working/Day Off roster across every home so
// the admin isn't retyping the same names into every box every day. The
// client only applies a suggestion into boxes that are still empty — this
// endpoint just proposes, it never touches the database itself.

const MODEL = 'claude-opus-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SUGGEST_SYSTEM = `You are Tello, helping a residential care home administrator fill in a day's
staffing roster across all of her homes. You're given recent history (who worked, who was off) for
each home over the past few weeks, plus the current staff directory.

Each home normally runs two main caregivers. When one of them is off, a reliever covers for about two
days — that's the typical pattern, not a hard rule. A name that shows up as "day off" repeatedly on the
same weekday as the target date is a strong signal that it repeats.

Using ONLY names that already appear in the history or the staff directory given to you — never invent
a name — infer the most likely Working and Day Off list for EVERY home you're given, for the target
date. If a home's history is too thin or inconsistent to guess confidently, leave both of that home's
fields as empty strings rather than guessing wildly — an empty guess is far better than a wrong one.

Respond with ONLY valid JSON, no markdown code fences, no commentary before or after, in exactly this
shape:
{"homes":[{"homeId":"<id from the list given>","working":"Name1\\nName2","dayOff":"Name3","note":"one short clause, or empty string if you left it blank"}]}
Include exactly one entry per home ID given, in the same order they were given. Use \\n between multiple
names in the same field, matching how the history is formatted. Keep each "note" under 20 words — it's
shown to the admin so she can sanity-check the pick at a glance.`;

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

  const date = typeof body?.date === 'string' ? body.date : '';
  const homeIds = Array.isArray(body?.homeIds) ? body.homeIds.filter((x) => typeof x === 'string') : [];
  const context = typeof body?.context === 'string' ? body.context.trim() : '';
  if (!date || !homeIds.length || !context) {
    return json({ error: 'Missing date, homeIds, or context' }, 400);
  }

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
        system: SUGGEST_SYSTEM,
        messages: [{
          role: 'user',
          content: `Target date: ${date}\nHome IDs to fill, in order: ${homeIds.join(', ')}\n\n${context}`,
        }],
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

  if (!parsed || !Array.isArray(parsed.homes)) {
    return json({ error: "Tello couldn't put together a usable suggestion — try again." }, 502);
  }

  const suggestions = parsed.homes
    .filter((h) => h && typeof h.homeId === 'string')
    .map((h) => ({
      homeId: h.homeId,
      working: typeof h.working === 'string' ? h.working : '',
      dayOff: typeof h.dayOff === 'string' ? h.dayOff : '',
      note: typeof h.note === 'string' ? h.note : '',
    }));

  return json({ suggestions });
}
