# MentorSync AI proxy

MentorSync is a static page on GitHub Pages. A static page **cannot** hold an
API key — everything it ships is readable by anyone who opens DevTools, and a
public Anthropic key is billed to whoever finds it. This small Cloudflare
Worker sits between the page and the Anthropic API so the key stays
server-side.

```
browser  ──POST──>  Worker (holds the key)  ──>  api.anthropic.com
```

Free tier covers 100,000 Worker requests/day, which is far more than this app
will use. You pay Anthropic for the model usage, nothing for the Worker.

---

## Deploy (about 5 minutes)

### 1. Install the Cloudflare CLI

```bash
npm install -g wrangler
wrangler login          # opens a browser, sign up free if you don't have an account
```

### 2. Deploy the Worker

From this `worker/` folder:

```bash
wrangler deploy
```

It prints a URL like:

```
https://mentorsync-ai.<your-subdomain>.workers.dev
```

Copy that URL — you need it in step 4.

### 3. Add the API key as a secret

```bash
wrangler secret put ANTHROPIC_API_KEY
```

Paste the key when prompted. It is stored encrypted by Cloudflare, is not
written to any file in this repository, and is never sent to the browser.

To change it later, run the same command again.

### 4. Point the page at the Worker

In `../index.html`, find this line near the top of the script section and put
your Worker URL in it:

```js
var MS_AI_ENDPOINT = '';   // <-- paste the workers.dev URL here
```

Commit and push. GitHub Pages rebuilds in about a minute.

**Leave it empty and nothing breaks** — the page falls back to its built-in
offline engine, exactly as it behaves today.

---

## Locking it down

`worker.js` has an `ALLOWED_ORIGINS` list near the top. Only those origins can
call the Worker, so nobody can point their own site at your endpoint and spend
your credit. Update it if the site moves:

```js
const ALLOWED_ORIGINS = [
  'https://anumentorsync-web.github.io',
  'http://localhost:8000',
];
```

Then `wrangler deploy` again.

Two further limits worth setting in the Cloudflare dashboard once this is live:

- **Workers → your worker → Settings → Rate limiting** — cap requests per IP so
  one person can't run up the bill.
- **Anthropic Console → Limits** — set a monthly spend cap on the API key.

---

## Testing it

```bash
curl -X POST https://mentorsync-ai.<your-subdomain>.workers.dev \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://anumentorsync-web.github.io' \
  -d '{"mode":"portfolio","messages":[{"role":"user","content":"What should a data science portfolio include?"}]}'
```

You should get back `{"text":"..."}`.

Live logs while you test:

```bash
wrangler tail
```

---

## What the page sends

```jsonc
POST /
{
  "mode": "feedback" | "feedback_qa" | "portfolio",
  "messages": [ { "role": "user" | "assistant", "content": "..." } ]
}
```

Response is `{"text": "..."}` on success, or `{"error": "..."}` on failure —
the page falls back to its offline engine whenever it gets an error, so a Worker
outage degrades the feature instead of breaking it.

System prompts live in `worker.js`, not in the page, so a learner can't open
DevTools and rewrite the instructions that grade their own assignment.
