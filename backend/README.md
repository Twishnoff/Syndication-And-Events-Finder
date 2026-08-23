# Syndication & Event Finder — backend

A Cloudflare Worker that powers the search behind the frontend in the parent
folder. It takes `{ email, companyUrl, jobTitles, industry, today }`, uses
Claude (with the web search tool) to research the company, find similar
companies, and search the web for events, meetups, newsletters, influencers,
publications, syndication platforms, and social/blog channels that match the
target job titles and industry (applying the exclusion rules and "job titles
broaden, don't narrow" ranking logic from the Iteration 1 doc), then returns:

- `companyName` — a human-readable name for the company at `companyUrl`.
- `results` — every good candidate per category (not capped server-side; the
  frontend caps each of its 7 boxes at 15).
- `allResults` — the same items flattened into one list with a `channel`
  field added, ordered by overall fit across every category — this feeds the
  uncapped "All Results" box.

This mirrors the same pattern as the Customer-Intelligence project's backend
— a single-file Worker calling the Anthropic API — deployed on the same
Cloudflare account.

## 1. Install wrangler (once)

```bash
npm install
```

(or `npm install -g wrangler` if you'd rather not keep a local `node_modules`)

## 2. Log in to Cloudflare (once)

```bash
npx wrangler login
```

## 3. Set secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# paste your Anthropic API key when prompted
```

That's the only secret you need to set for a fresh deploy. The approved-email
allow-list now syncs live from the Google Doc instead of a secret — see
"Email allow-list source" below — so you only need `wrangler secret put
ALLOWED_EMAILS` if you want a manual fallback list (optional).

## 4. (Optional) non-secret settings

Edit `wrangler.toml`'s `[vars]` section, or set them ad hoc:

- `ALLOWED_EMAILS_DOC_ID` — the Google Doc ID of the live approved-emails
  allow-list doc (already set to the current doc in `wrangler.toml`). See
  "Email allow-list source" below.
- `ALLOWED_EMAILS_CACHE_TTL_SECONDS` — how long (seconds) the Worker
  edge-caches the doc fetch before re-reading it. Defaults to `300` (5
  minutes) — so a doc edit takes up to 5 minutes to take effect, not
  instantly. Lower it if you need faster propagation.
- `ANTHROPIC_MODEL` — override the default model id in `worker.js`
  (`DEFAULT_MODEL_ID`) without redeploying code. Check
  https://docs.claude.com/en/docs/about-claude/models for current model ids.
- `ALLOWED_ORIGIN` — restrict CORS to your GitHub Pages origin, e.g.
  `https://twishnoff.github.io`. Defaults to `*` (any origin) if unset.

## 5. Deploy

```bash
npx wrangler deploy
```

This should publish to `https://syndication-event-finder.<your-subdomain>.workers.dev`,
which is exactly what `config.js` in the parent folder already expects
(`SYNDICATION_API_URL`). If your Cloudflare workers.dev subdomain isn't
`tyler-wishnoff`, update `config.js` to match whatever URL `wrangler deploy`
prints.

## 6. Test it

```bash
curl -X POST https://syndication-event-finder.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "email": "you@example.com",
    "companyUrl": "https://example.com",
    "jobTitles": ["Data Engineer"],
    "industry": "Oil and Gas",
    "today": "2026-08-22"
  }'
```

You should get back `{"status":"ok","companyName":"...","results":{...},"allResults":[...]}`.
Category arrays in `results` may be empty — that's expected and the frontend
shows "No Relevant Results Found" for those. `allResults` should contain the
same items as `results` combined, just flattened with a `channel` label and
reordered by overall fit (it's normal for it to interleave categories rather
than group them).

## Notes / things to double-check

- **Model & tool names drift.** Anthropic periodically updates model ids and
  the exact `type` string for the web search tool. If you get a 400 error
  mentioning `model` or `tools`, check the current docs and update
  `DEFAULT_MODEL_ID` / `WEB_SEARCH_TOOL_TYPE` at the top of `worker.js` (or
  just set `ANTHROPIC_MODEL` as a var to avoid a code change for the model).
- **Cost/latency.** Each request lets Claude make up to 12 web searches
  (`max_uses: 12` in `worker.js`) before answering, so a single search can
  take a while (around a minute is typical) and use a meaningful number of
  tokens — the response also got larger with this iteration (uncapped
  categories plus the flattened `allResults` list), so `max_tokens` was
  raised to 16000 accordingly. Lower `max_uses` if you want faster/cheaper
  responses at the cost of thinner research, or raise the Worker's CPU time
  limits on paid Cloudflare plans if you see timeouts.
- **Company snapshot fetch.** The worker does a best-effort raw GET of the
  company homepage to give Claude a head start; if the site blocks bots or
  requires JS to render, this snapshot may come back empty and Claude will
  rely on its own web search of the domain instead — it's not fatal.
- **Email allow-list source.** The Worker reads the approved-emails list
  live from the Google Doc referenced in the spec, via `ALLOWED_EMAILS_DOC_ID`
  in `wrangler.toml` — no manual copy/paste or redeploy needed when the list
  changes. This only works because the doc's sharing is set to "Anyone with
  the link: Viewer" (Drive lets it stay unlisted — not searchable, not
  editable by strangers — while still being fetchable by the Worker without
  authentication). If you ever change the doc's sharing to "Restricted," the
  Worker will fail to read it and silently fall back to the `ALLOWED_EMAILS`
  secret (empty by default, which means "allow-list check skipped, anyone
  gets in") — so if access suddenly seems wrong for everyone, check the
  doc's sharing settings first. Expected format in the doc: one email per
  line (or comma-separated), case doesn't matter, blank lines are ignored.
  A change to the doc takes effect within `ALLOWED_EMAILS_CACHE_TTL_SECONDS`
  (default 5 minutes), not instantly.
