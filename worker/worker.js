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

// Two providers are supported. Whichever key is present in the Worker's
// secrets is used — GEMINI_API_KEY first, since its free tier means it needs
// no billing. Set only one; set both and Gemini wins.
const MODEL = 'claude-opus-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Gemini model names come and go — a hardcoded one eventually 404s with
// "no longer available to new users". So the model is discovered from the
// account's own model list and cached, instead of being guessed here.
// Set a plain GEMINI_MODEL variable in the Worker's settings to pin one.
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Bumped whenever this file changes. Reported by ?selftest=1 so a stale
// deploy is visible instead of being mistaken for a broken key.
const WORKER_VERSION = '2026-08-19-b';

// Fallbacks used only if the model list itself cannot be fetched.
const GEMINI_FALLBACKS = ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-pro-latest'];

let resolvedGeminiModel = null; // cached for the life of the Worker instance

function listGeminiModels(env) {
  return fetch(GEMINI_API_BASE + '/models?pageSize=200&key=' +
    encodeURIComponent(env.GEMINI_API_KEY));
}

// Prefers the newest "flash" generation: fast, cheap, and the highest free
// daily quota. Falls back to pro-class models if no flash is offered.
function rankGeminiModel(name) {
  if (/embedding|aqa|imagen|veo|tts|image|audio|native|thinking-exp/.test(name)) return -1000;
  let score = 0;
  const version = name.match(/gemini-(\d+)(?:\.(\d+))?/);
  if (version) score += parseInt(version[1], 10) * 30 + (parseInt(version[2], 10) || 0) * 3;
  if (/latest/.test(name)) score += 25;       // stable alias, survives renames
  if (/flash/.test(name)) score += 60;        // best free-tier daily quota
  else if (/pro/.test(name)) score += 20;
  if (/lite/.test(name)) score -= 15;         // cheaper, weaker on grading
  // Previews carry lower quotas and are withdrawn without notice, so they
  // rank below any stable model but stay usable if nothing else is offered.
  if (/preview|exp/.test(name)) score -= 250;
  return score;
}

// Every model this key can call, best first. Empty if the list can't be read.
async function discoverGeminiModels(env) {
  try {
    const res = await listGeminiModels(env);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || [])
      .filter(function (m) {
        return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
      })
      .map(function (m) { return String(m.name).replace(/^models\//, ''); })
      .filter(function (n) { return rankGeminiModel(n) > -1000; })
      .sort(function (a, b) { return rankGeminiModel(b) - rankGeminiModel(a); });
  } catch (e) {
    return [];
  }
}

async function resolveGeminiModel(env) {
  if (env.GEMINI_MODEL) return env.GEMINI_MODEL;
  if (resolvedGeminiModel) return resolvedGeminiModel;
  const usable = await discoverGeminiModels(env);
  resolvedGeminiModel = usable.length ? usable[0] : GEMINI_FALLBACKS[0];
  return resolvedGeminiModel;
}

function geminiUrl(model) {
  return GEMINI_API_BASE + '/models/' + model + ':generateContent';
}

function providerOf(env) {
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

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

// Emits a tagged structure rather than prose. The page parses it into
// per-section cards showing the learner's own excerpt above the fix, which
// reads far faster than a paragraph list. Tagged plain text (not JSON)
// because it degrades readably if a model ignores part of the format.
const FEEDBACK_SYSTEM = [
  'You are MentorSync, a strict, precise assignment grader for EduClaas learners.',
  'You will be given the full text of a learner\'s actual submission. Read it properly — including technical or subject-specific terminology in any field — and judge it on its real content, not on whether particular keywords appear.',
  '',
  'OUTPUT FORMAT — reply with ONLY the tags below, nothing before or after. No markdown, no headers, no emoji, no preamble.',
  '',
  'GRADE: <number>/100',
  'VERDICT: <one sentence, max 20 words, naming the single biggest thing holding the grade back>',
  '',
  'Then 3 to 5 blocks, each exactly:',
  '',
  '[SECTION] <2-4 words naming the part of the submission, e.g. Introduction, Evidence, Conclusion, Referencing, Paragraph 4>',
  '[QUOTE] <a VERBATIM extract of 8-25 words copied exactly from their submission, showing the problem. If the problem is that something is absent, write: (not present)>',
  '[ISSUE] <one sentence, max 20 words, on what is wrong with that specific extract>',
  '[FIX] <one sentence, max 25 words, on exactly what to change it to. Where useful, write the improved line for them.>',
  '',
  'RULES:',
  '- [QUOTE] must be copied character-for-character from the submission. Never paraphrase it, never invent it.',
  '- Order the blocks most-impactful first.',
  '- Every line must be specific to THIS submission. No advice that could apply to any essay.',
  '- Keep every line short. Brevity is the point of this format — no padding, no encouragement filler.',
  '- Base the grade on the actual quality of argument, evidence, structure and clarity. Never default to a baseline score.',
  '- If the text is very short, incomplete, or not an assignment, say so in VERDICT and grade accordingly.',
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

// A learner with a portfolio already built wants it critiqued, not explained.
// Different job from PORTFOLIO_SYSTEM, so it gets its own prompt.
const PORTFOLIO_REVIEW_SYSTEM = [
  'You are MentorSync, reviewing an EduClaas learner\'s existing portfolio. They have already built it — they want it improved, not explained. Never give general "how to build a portfolio" advice.',
  '',
  'Judge it the way a recruiter skimming for 15 seconds would, then the way a hiring manager reading properly would.',
  '',
  'OUTPUT FORMAT — exactly this, plain text, **bold** for the two headers only, no markdown headers, no emoji:',
  'What to improve',
  '• (4-6 bullets, ordered most-impactful first. Each must quote or name the exact section, project or line you mean, and say specifically what to change it to. Rewrite weak lines for them where it helps.)',
  '',
  'What is already working',
  '• (1-3 bullets, only if genuinely true. Omit this section entirely rather than inventing praise.)',
  '',
  'JUDGE ON:',
  '- Evidence over claims: is every project linked to a live site, repo or artefact, or only described?',
  '- Measurable outcomes: does each project state a result with a number, or only list tasks?',
  '- Strongest work first: would a 15-second skim land on their best project?',
  '- Structure: About Me, Skills (technical split from soft), Projects, Certifications, Contact.',
  '- Contact visibility: email and LinkedIn findable without scrolling or hunting.',
  '- Pillar fit: does the evidence prove competence in the field they are targeting?',
  '',
  'If given only a URL and no content, do not pretend to have seen the site. Say so in one line, then give a precise section-by-section audit checklist they can apply themselves.',
  'No padding, no encouragement filler. Every line must be specific and actionable. Do not include internal or system XML tags in your response.',
].join('\n');

// Drives the guided builder. The page supplies which step the person is on
// and what they said about themselves; this returns content they can paste
// straight into that section, not advice about how to write it.
const PORTFOLIO_STEP_SYSTEM = [
  'You are MentorSync, walking someone through building their portfolio one section at a time, inside EduClaas.',
  'The user message states which STEP they are on, who they are, and what they have told you about themselves.',
  '',
  'Your job is to produce the actual content for that step, ready to paste. Not advice about how to write it.',
  '',
  'OUTPUT FORMAT — reply with ONLY the tags below, nothing before or after. No markdown headers, no emoji, no preamble.',
  '',
  'DRAFT:',
  '<the finished text for this section, written in their voice, first person where natural. Use plain line breaks between items. If the step needs a list (skills, projects, certifications), give the list itself, formatted and ready to use.>',
  '',
  'NOTES:',
  '• <2-4 short bullets: what you assumed, what they should swap in, and the single thing that would most strengthen this section>',
  '',
  'RULES:',
  '- Write for the field and seniority they describe. A ten-year data scientist and a first-year Business IT learner get materially different drafts.',
  '- Anyone may use this — learner, lecturer, mentor, working professional. Never assume they are a student unless they say so.',
  '- The user message may include a COACHING STATUS line. If it says they have attended an EduClaas career-builder workshop and/or a 1:1 coaching session with target roles stated, write every section directly toward those roles. If it says they have not, do not invent or assume a target role — lead with the business problem they solved, what they built, and the outcome, and let that evidence speak for itself rather than pitching a role.',
  '- This is for EduClaas Diploma / SCTP-funded learners (D2), not postgraduate or master\'s-level candidates. Do not reference master\'s coursework, thesis work, or postgraduate research as if it applies here.',
  '- Where they have not given you a detail, write a realistic placeholder in [square brackets] rather than leaving a gap or asking for it.',
  '- Be concrete. Name real tools, real metrics, real outcomes appropriate to their field.',
  '- Never invent qualifications, employers or numbers as though they were facts — those go in [brackets] for them to fill.',
  '- Never fabricate a business result and never convert a simulated or course project into claimed employment experience. But do not diminish real applied work either — do not repeatedly call it "just an assignment". Position it as applied project experience: write "As part of an applied [field] project, I built an interactive dashboard to analyse sales and customer performance," not "For my course assignment, I had to create a dashboard." Keep demonstrated results clearly separate from potential business value.',
  '- No filler, no encouragement, no restating the question.',
  '- Do not include internal or system XML tags in your response.',
].join('\n');

const MODES = {
  feedback: { system: FEEDBACK_SYSTEM, maxTokens: 4000 },
  feedback_qa: { system: FEEDBACK_QA_SYSTEM, maxTokens: 2000 },
  portfolio: { system: PORTFOLIO_SYSTEM, maxTokens: 2000 },
  portfolio_review: { system: PORTFOLIO_REVIEW_SYSTEM, maxTokens: 3000 },
  portfolio_step: { system: PORTFOLIO_STEP_SYSTEM, maxTokens: 2500 },
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
// Gemini's shape differs from Anthropic's: the system prompt is its own
// field, roles are user/model rather than user/assistant, and the text sits
// under parts[].
// Gemini's request schema differs across generations: 2.x accepts
// thinkingConfig.thinkingBudget, 3.x rejects it as an invalid argument.
// Rather than track which model wants which, the body is built in three
// progressively simpler variants and the first the model accepts is used.
function geminiBody(mode, messages, variant) {
  const config = MODES[mode];
  const body = {
    systemInstruction: { parts: [{ text: config.system }] },
    contents: messages.map(function (m) {
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      };
    }),
  };

  if (variant === 0) {
    // 2.x: reasoning off, whole budget to the reply.
    body.generationConfig = {
      maxOutputTokens: config.maxTokens,
      temperature: 0.3,
      thinkingConfig: { thinkingBudget: 0 },
    };
  } else if (variant === 1) {
    // 3.x: thinkingBudget is rejected; thinkingLevel is the equivalent knob.
    body.generationConfig = {
      maxOutputTokens: config.maxTokens * 2,
      temperature: 0.3,
      thinkingConfig: { thinkingLevel: 'low' },
    };
  } else if (variant === 2) {
    // No thinking control at all. Reasoning shares the output budget, so it
    // is tripled to leave room for an actual answer on long submissions.
    body.generationConfig = {
      maxOutputTokens: config.maxTokens * 3,
      temperature: 0.3,
    };
  }
  // variant 3: no generationConfig — provider defaults.
  return body;
}

const GEMINI_VARIANTS = 4;

async function postGemini(env, model, mode, messages, variant) {
  return fetch(geminiUrl(model) + '?key=' + encodeURIComponent(env.GEMINI_API_KEY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody(mode, messages, variant)),
  });
}

// Remembers which body shape this model accepted, so the retry ladder is
// walked once rather than on every request.
let geminiVariant = 0;

// A 200 carrying no text is as useless as a 400 — most often the model spent
// the entire output budget on reasoning. Both are treated as "try the next
// body shape", so the ladder recovers from either.
async function readGeminiAttempt(res) {
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) {}
  const text = data ? extractGeminiText(data) : '';
  const finish = data && data.candidates && data.candidates[0]
    ? data.candidates[0].finishReason : null;
  return { res: res, raw: raw, data: data, text: text, finish: finish,
           usable: res.ok && !!text };
}

async function postGeminiAdaptive(env, model, mode, messages) {
  let attempt = await readGeminiAttempt(
    await postGemini(env, model, mode, messages, geminiVariant));
  if (attempt.usable || attempt.res.status === 404) return attempt;

  for (let v = 0; v < GEMINI_VARIANTS; v++) {
    if (v === geminiVariant) continue;
    const next = await readGeminiAttempt(
      await postGemini(env, model, mode, messages, v));
    if (next.res.status === 404) return next;
    if (next.usable) { geminiVariant = v; return next; }
    attempt = next;
  }
  return attempt; // nothing worked — return the last so its reason surfaces
}

async function callGemini(env, mode, messages) {
  const first = await resolveGeminiModel(env);
  let res = await postGeminiAdaptive(env, first, mode, messages);
  if (res.res.status !== 404) { resolvedGeminiModel = first; return res; }

  // 404 means the model is gone. A pinned GEMINI_MODEL is treated as a
  // preference, not a contract, so a retired pin cannot take the app down.
  resolvedGeminiModel = null;
  const tried = [first];
  const discovered = await discoverGeminiModels(env);
  const candidates = discovered.concat(GEMINI_FALLBACKS);

  for (const candidate of candidates) {
    if (tried.indexOf(candidate) !== -1) continue;
    tried.push(candidate);
    res = await postGeminiAdaptive(env, candidate, mode, messages);
    if (res.res.status !== 404) {
      resolvedGeminiModel = candidate;
      return res;
    }
  }
  return res;
}

function extractGeminiText(data) {
  const cand = (data.candidates || [])[0];
  if (!cand) return '';
  return ((cand.content && cand.content.parts) || [])
    .map(function (p) { return p.text || ''; })
    .join('')
    .trim();
}

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
  const provider = providerOf(env);
  if (!provider) {
    return json({ ok: false, version: WORKER_VERSION, step: 'api key', detail:
      'No API key secret is set on this Worker. Add one under Settings > Variables and Secrets, named exactly GEMINI_API_KEY (free tier) or ANTHROPIC_API_KEY (paid).' }, 200, origin);
  }
  let out;
  try {
    out = await runModel(env, 'portfolio',
      [{ role: 'user', content: 'Reply with the single word OK.' }]);
  } catch (e) {
    return json({ ok: false, version: WORKER_VERSION, provider: provider, step: 'network',
      detail: 'Worker could not reach the model provider: ' + e.message }, 200, origin);
  }

  const base = {
    version: WORKER_VERSION,
    provider: provider,
    model: provider === 'gemini' ? (resolvedGeminiModel || env.GEMINI_MODEL) : MODEL,
    pinned: env.GEMINI_MODEL || null,
    bodyVariant: provider === 'gemini' ? geminiVariant : null,
  };

  if (!out.ok) {
    const body = Object.assign({ ok: false }, base, {
      step: 'provider rejected the request',
      http: out.status,
      finishReason: out.finish || null,
      detail: out.error,
    });
    // Only suggest a key problem when the error actually looks like one —
    // a 400 about request arguments is not a credentials issue.
    if (provider === 'gemini' &&
        (out.status === 401 || out.status === 403 || /API key|credential|permission/i.test(out.error || ''))) {
      body.hint = 'Check the key came from https://aistudio.google.com/apikey (Get API key) rather than from Google Cloud credentials, and that the Generative Language API is enabled for its project.';
    }
    return json(body, 200, origin);
  }

  return json(Object.assign({ ok: true }, base, { step: 'done', reply: out.text }), 200, origin);
}

// Single entry point for both providers. Always resolves to the same shape:
// { ok, text } on success, or { ok:false, status, error, finish } on failure.
async function runModel(env, mode, messages) {
  if (providerOf(env) === 'gemini') {
    const a = await callGemini(env, mode, messages);
    if (a.usable) return { ok: true, text: a.text };
    return {
      ok: false,
      status: a.res.status,
      finish: a.finish,
      error: a.res.ok
        ? ('Model returned no text' + (a.finish ? ' (finishReason: ' + a.finish + ')' : '') + '.')
        : errorReason(a.raw, a.res.status),
    };
  }

  const res = await callAnthropic(env.ANTHROPIC_API_KEY, mode, messages);
  const raw = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: errorReason(raw, res.status) };
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    return { ok: false, status: 502, error: 'Response was not JSON' };
  }
  if (data.stop_reason === 'refusal') {
    return { ok: false, status: 200, error: 'The AI declined to answer that request.' };
  }
  const text = extractText('anthropic', data);
  if (!text) return { ok: false, status: 502, error: 'Model returned no text.' };
  return { ok: true, text: text };
}

function extractText(provider, data) {
  if (provider === 'gemini') return extractGeminiText(data);
  return (data.content || []).filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('').trim();
}

// Pull the provider's own explanation out of an error body — it names the
// real problem (bad key, quota exhausted, no credit) instead of a status code.
function errorReason(raw, status) {
  try {
    const p = JSON.parse(raw);
    if (p.error && (p.error.message || p.error.type)) return p.error.message || p.error.type;
  } catch (e) {}
  return 'HTTP ' + status;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const query = new URL(request.url).searchParams;
    if (query.has('models')) {
      if (providerOf(env) !== 'gemini') {
        return json({ error: 'No GEMINI_API_KEY is set on this Worker.' }, 400, origin);
      }
      const res = await listGeminiModels(env);
      const raw = await res.text();
      if (!res.ok) return json({ ok: false, detail: errorReason(raw, res.status) }, 200, origin);
      const models = (JSON.parse(raw).models || [])
        .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1; })
        .map(function (m) { return String(m.name).replace(/^models\//, ''); });
      return json({ chosen: await resolveGeminiModel(env), available: models.sort() }, 200, origin);
    }
    if (query.has('selftest')) {
      return selfTest(env, origin);
    }
    if (request.method !== 'POST') {
      return json({ error: 'Use POST. Add ?selftest=1 to this URL to check whether the API key works.' }, 405, origin);
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Origin not allowed.' }, 403, origin);
    }
    if (!providerOf(env)) {
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

    const provider = providerOf(env);
    let out;
    try {
      out = await runModel(env, mode, messages);
    } catch (e) {
      return json({ error: 'Worker could not reach the AI service.' }, 502, origin);
    }

    if (!out.ok) {
      console.log(provider + ' failed', out.status, out.error, out.finish || '');
      if (out.status === 429) {
        return json({ error: 'The AI service is busy or the daily free quota is used up. Please try again later.' }, 429, origin);
      }
      // Forward the provider's own reason rather than a generic failure —
      // it names the actual problem and saves rounds of guessing.
      return json({ error: out.error }, 502, origin);
    }

    const text = out.text;
    return json({ text: text }, 200, origin);
  },
};
