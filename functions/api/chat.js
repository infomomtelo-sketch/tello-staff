// Cloudflare Pages Function — POST /api/chat
// Server-side only: calls SecondRail (https://secondrail.tello.live/v1/messages),
// the Anthropic-compatible failover gateway — it routes to OpenRouter, so the
// chat keeps answering even when the Anthropic account is empty. (The direct
// Anthropic key failed with "Your credit balance is too low to access the
// Anthropic API" — the key authenticated, the account had no credit.)
// Reads SECONDRAIL_API_KEY from the environment (must be set WITHOUT a
// VITE_/PUBLIC_ prefix so it never reaches the browser bundle).

const MODEL = 'claude-opus-5';
const SECONDRAIL_URL = 'https://secondrail.tello.live/v1/messages';

const TELLO_IDENTITY = `You are Tello, the operations co-pilot inside Tello Staff — a tool
a residential care home administrator uses to run day-to-day staffing across her homes.
Speak plainly and practically; this is a working tool, not a demo. Ground every answer in
the schedule data given to you below — never invent staff names, homes, or shifts that
aren't in it. When asked who can cover a shift or fill a gap, name specific people who are
actually free that day (not already assigned elsewhere that slot) and say the trade-off
plainly (e.g. "Rowena is free, but she'd be on 6 straight days"). Say clearly when there is
no good answer rather than forcing one. Keep replies short and conversational — a few
sentences, not a report — unless the admin asks for more detail.`;

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

  const apiKey = env.SECONDRAIL_API_KEY;
  if (!apiKey) {
    return json({ error: 'SECONDRAIL_API_KEY is not configured on the server' }, 500);
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

  let railRes;
  try {
    railRes = await fetch(SECONDRAIL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: `${TELLO_IDENTITY}\n\nCurrent schedule data:\n${context}`,
        messages: turns,
      }),
    });
  } catch (err) {
    return json({ error: `Could not reach SecondRail: ${err.message}` }, 502);
  }

  const data = await railRes.json();

  // Surface the real reason (bad key, rate limit) instead of a generic
  // failure string that looks like a model problem.
  if (!railRes.ok) {
    return json({ error: data?.error?.message || `SecondRail error (${railRes.status})` }, railRes.status);
  }

  const reply = data.content && data.content[0] && data.content[0].text
    ? data.content[0].text
    : 'Unable to reply.';

  return json({ reply });
}
