/**
 * MentorSync AI proxy — Cloudflare Worker
 * ----------------------------------------
 * The MentorSync front-end is a static page on GitHub Pages. A static page
 * cannot hold an API key: anything shipped to the browser is readable by
 * anyone who opens DevTools. This Worker sits between the page and the
 * Anthropic API so the key stays server-side.
 *
 *   browser  ──POST──>  this Worker  ──x-api-key──>  api.anthropic.com
 *
 * The key is supplied as the ANTHROPIC_API_KEY secret (see README.md in this
 * folder). It is never written to this file and never sent to the browser.
 *
 * The system prompts also live here rather than in the page, so a learner
 * can't edit them in DevTools to change how their work is graded.
 */

const MODEL = 'claude-opus-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Origins allowed to call this Worker. Add your GitHub Pages origin and any
// local dev origin you use. Requests from anywhere else are refused, so the
// endpoint can't be repurposed as a free API for other sites.
const ALLOWED_ORIGINS = [
  'https://anumentorsync-web.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

// Longest submission we will forward (~50,000 words). Anything past this is
// truncated with a note rather than silently failing.
const MAX_CHARS = 300000;

const FEEDBACK_SYSTEM = [
  'You are MentorSync, a strict, precise assignment grader and feedback mentor for EduClaas learners.',
  'You will be given the full text of a learner\'s actual submission. Read it properly — including technical or subject-specific terminology in any field (marketing, data science, software engineering, business) — and judge it on its real content, not on whether particular keywords appear.',
  '',
  'OUTPUT FORMAT — exactly this structure, plain text, **bold** only for the two headers, no markdown headers, no emoji:',
  'Areas for Improvement',
  '• (3-5 bullets, each specific to what THIS submission actually does or is missing — quote or paraphrase the exact part you mean. No generic advice that could apply to any essay.)',
  '',
  'Estimated Grade',
  '(a specific number)/100 — (one sentence justifying it from THIS submission\'s actual strengths and weaknesses)',
  '',
  'RULES:',
  '- Base the grade strictly on the actual quality of argument, evidence, structure and clarity in the text given. Never default to a fixed baseline score.',
  '- If the text is very short, clearly incomplete, or not an assignment, say so plainly and grade accordingly (it can be low).',
  '- No padding, no encouragement filler. Every line must be specific and actionable.',
  '- Do not invent a word-count requirement. Note the actual word count only if it looks unusually short for a full assignment.',
  '- Do not include internal or system XML tags in your response.',
].join('\n');

const FEEDBACK_QA_SYSTEM = [
  'You are MentorSync, a strict, precise assignment-writing mentor for EduClaas learners.',
  'Answer whatever the learner asks — writing help, referencing, structure, or general academic questions — directly and specifically.',
  'Always give a concrete answer, including your best answer on specifics you are not fully certain of. Never refuse or redirect the learner elsewhere.',
  'No filler openers, no restating the question, no hedging unless genuinely warranted. Default to 2-4 sentences or a tight list unless the question needs a full walkthrough.',
  'If the question is genuinely ambiguous, ask exactly one short clarifying question instead of guessing.',
  'Plain text, **bold** for key terms only, no headers, no emoji. Do not include internal or system XML tags in your response.',
].join('\n');

const PORTFOLIO_SYSTEM = [
  'You are MentorSync, the virtual mentor for EduClaas learners (pillars: Business IT, Data Science, Digital Business, Software Engineering, Systems Management), working inside the Portfolio Support feature.',
  'Portfolio building — structure, content, and the two recommended tools (Carrd and Framer) — is your specialty, but you are not limited to it. Answer whatever the learner actually asks, including general academic, career, or study questions. Never redirect a question elsewhere.',
  '',
  'Carrd: free tier allows up to 3 sites, one-page templates, live in about 30 minutes, limited CSS customisation, theme cannot be swapped after starting.',
  'Framer: multi-page, animations, 2000+ switchable templates, a more designed feel, steeper learning curve — check framer.com for current plan details before recommending a paid tier.',
  '',
  'PRECISION — answer the exact question asked. No filler openers, no restating the question, no hedging unless genuine uncertainty exists.',
  'LENGTH — default to 2-4 sentences or a tight 3-5 item list. Go longer only when the learner asks for a full structure or walkthrough.',
  'TAILORING — when the learner names their pillar or profession, make the answer specific to it (what to include, what evidence proves competence in that field).',
  'AMBIGUITY — ask exactly one short clarifying question rather than answering vaguely.',
  'Plain text, **bold** for key terms only, no markdown headers, no code blocks, no emoji. Do not include internal or system XML tags in your response.',
].join('\n');

const MODES = {
  feedback: { system: FEEDBACK_SYSTEM, maxTokens: 4000 },
  feedback_qa: { system: FEEDBACK_QA_SYSTEM, maxTokens: 2000 },
  portfolio: { system: PORTFOLIO_SYSTEM, maxTokens: 2000 },
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin)),
  });
}

// Thinking shares the max_tokens budget with the reply on this model, so a
// small budget can be consumed entirely by reasoning and return empty text.
// These are short, well-specified tasks, so thinking is turned off and the
// whole budget goes to the answer. (Permitted at effort `high` or below.)
function callAnthropic(apiKey, mode, messages) {
  const config = MODES[mode];
  return fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: config.maxTokens,
      thinking: { type: 'disabled' },
      output_config: { effort: 'medium' },
      system: config.system,
      messages: messages,
    }),
  });
}

// Plain-English health check: open the Worker URL with ?selftest=1 in a
// browser and it reports whether the key actually works, in one click.
async function selfTest(env, origin) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ ok: false, step: 'api key', detail:
      'No ANTHROPIC_API_KEY secret is set on this Worker. Add it under Settings > Variables and Secrets, named exactly ANTHROPIC_API_KEY.' }, 200, origin);
  }
  let res;
  try {
    res = await callAnthropic(env.ANTHROPIC_API_KEY, 'portfolio',
      [{ role: 'user', content: 'Reply with the single word OK.' }]);
  } catch (e) {
    return json({ ok: false, step: 'network', detail: 'Worker could not reach api.anthropic.com: ' + e.message }, 200, origin);
  }
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try { const p = JSON.parse(raw); detail = (p.error && (p.error.message || p.error.type)) || raw; } catch (e) {}
    return json({ ok: false, step: 'anthropic', http: res.status, detail: detail }, 200, origin);
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    return json({ ok: false, step: 'parse', detail: raw.slice(0, 400) }, 200, origin);
  }
  const text = (data.content || []).filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('').trim();
  return json({
    ok: !!text,
    step: text ? 'done' : 'empty reply',
    model: data.model,
    stop_reason: data.stop_reason,
    reply: text,
    usage: data.usage,
  }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (new URL(request.url).searchParams.has('selftest')) {
      return selfTest(env, origin);
    }
    if (request.method !== 'POST') {
      return json({ error: 'Use POST. Add ?selftest=1 to this URL to check whether the API key works.' }, 405, origin);
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Origin not allowed.' }, 403, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Server is not configured with an API key.' }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'Body must be JSON.' }, 400, origin);
    }

    const mode = MODES[body.mode] ? body.mode : 'feedback_qa';
    const config = MODES[mode];

    // `messages` is [{role, content}] — the page sends the running conversation
    // so follow-up questions keep their context.
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const messages = [];
    for (const m of incoming) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      let text = String(m.content == null ? '' : m.content);
      if (!text.trim()) continue;
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) +
          '\n\n[Note: this submission was truncated for length — base your feedback only on the portion shown, and say in your response that this was a partial read.]';
      }
      messages.push({ role: m.role, content: text });
    }
    if (!messages.length || messages[0].role !== 'user') {
      return json({ error: 'Send at least one user message.' }, 400, origin);
    }

    let upstream;
    try {
      upstream = await callAnthropic(env.ANTHROPIC_API_KEY, mode, messages);
    } catch (e) {
      return json({ error: 'Worker could not reach the AI service.' }, 502, origin);
    }

    if (!upstream.ok) {
      const raw = await upstream.text();
      console.log('Anthropic API error', upstream.status, raw);
      if (upstream.status === 429) {
        return json({ error: 'The AI service is busy right now. Please try again in a moment.' }, 429, origin);
      }
      // Forward Anthropic's own reason. It names the actual problem (expired
      // key, credit balance, bad request) instead of a generic failure that
      // takes several rounds of guessing to diagnose.
      let reason = 'HTTP ' + upstream.status;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error && (parsed.error.message || parsed.error.type)) {
          reason = parsed.error.message || parsed.error.type;
        }
      } catch (e) {}
      return json({ error: reason }, 502, origin);
    }

    const data = await upstream.json();

    if (data.stop_reason === 'refusal') {
      return json({ error: 'The AI declined to answer that request.' }, 200, origin);
    }

    const text = (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('')
      .trim();

    if (!text) {
      return json({ error: 'The AI returned an empty response.' }, 502, origin);
    }
    return json({ text: text }, 200, origin);
  },
};
