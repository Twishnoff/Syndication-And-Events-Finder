# Syndication & Event Finder — backend

A Cloudflare Worker that powers the search behind the frontend in the parent
folder. It takes `{ email, companyUrl, jobTitles, industry, today }`, uses
Claude (with the web search tool) to research the company, find similar
companies, and search the web for events, meetups, newsletters, influencers,
publications, syndication platforms, and social/blog channels that match the
target job titles and industry, then returns up to 15 ranked results per
category.

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

npx wrangler secret put ALLOWED_EMAILS
# paste the approved emails, comma or newline separated, e.g.:
# tyler@example.com, teammate@example.com
```

`ALLOWED_EMAILS` should match the list from the allow-list doc referenced in
the spec. If you leave it unset (empty), the worker will skip the allow-list
check and accept any syntactically valid email — only do that intentionally.

## 4. (Optional) non-secret settings

Edit `wrangler.toml`'s `[vars]` section, or set them ad hoc:

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

You should get back `{"status":"ok","results":{...}}` with up to 15 items in
each of the seven category arrays (some may be empty — that's expected and
the frontend shows "No Relevant Results Found" for those).

## Notes / things to double-check

- **Model & tool names drift.** Anthropic periodically updates model ids and
  the exact `type` string for the web search tool. If you get a 400 error
  mentioning `model` or `tools`, check the current docs and update
  `DEFAULT_MODEL_ID` / `WEB_SEARCH_TOOL_TYPE` at the top of `worker.js` (or
  just set `ANTHROPIC_MODEL` as a var to avoid a code change for the model).
- **Cost/latency.** Each request lets Claude make up to 12 web searches
  (`max_uses: 12` in `worker.js`) before answering, so a single search can
  take a while and use a meaningful number of tokens. Lower `max_uses` if you
  want faster/cheaper responses at the cost of thinner research, or raise the
  Worker's CPU time limits on paid Cloudflare plans if you see timeouts.
- **Company snapshot fetch.** The worker does a best-effort raw GET of the
  company homepage to give Claude a head start; if the site blocks bots or
  requires JS to render, this snapshot may come back empty and Claude will
  rely on its own web search of the domain instead — it's not fatal.
- **Email allow-list source.** The spec points at a Google Doc listing
  approved emails. The worker can't read a live Google Doc, so copy that
  list into the `ALLOWED_EMAILS` secret whenever it changes.
