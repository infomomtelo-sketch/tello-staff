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
