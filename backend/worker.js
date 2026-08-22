/**
 * Syndication & Event Finder — Cloudflare Worker backend
 * -------------------------------------------------------
 * Implements the research/ranking logic described in the spec doc and the
 * Iteration 1 follow-up doc: given a company URL, up to three job titles,
 * and an optional industry, it researches the company, finds
 * similar/competitor companies, and searches the web for events, meetups,
 * newsletters, influencers, publications, syndication platforms, and
 * social/blog channels that would reach that audience. It applies the
 * exclusion rules (no competitor-branded channels except major agnostic
 * tradeshows, no vendor-owned blogs/social/pubs, no competitor-affiliated
 * influencers) and the "job titles broaden, don't narrow" ranking rule from
 * that follow-up doc. It returns, per category, every good candidate found
 * (the frontend caps each category box's display at 15, but does not cap
 * the "All Results" box), plus a flattened "allResults" list ordered by
 * overall fit across all categories for that box — all in the exact JSON
 * shape the frontend (app.js) expects.
 *
 * Required secrets/vars (see README.md for `wrangler secret put` commands):
 *   ANTHROPIC_API_KEY  - required. Your Anthropic API key.
 *   ALLOWED_EMAILS     - required. Comma or newline separated list of the
 *                        approved emails (from the allow-list doc referenced
 *                        in the spec). Case-insensitive.
 *   ANTHROPIC_MODEL    - optional. Defaults to DEFAULT_MODEL_ID below.
 *   ALLOWED_ORIGIN     - optional. Defaults to "*". Set to
 *                        "https://twishnoff.github.io" to lock CORS down
 *                        to the GitHub Pages site once you've deployed.
 *
 * NOTE ON MODEL / TOOL NAMES: Anthropic occasionally revises the web search
 * tool's type string and model ids. If deploys start failing with a 400
 * referencing "tools" or an unknown model, check
 * https://docs.claude.com/en/docs/about-claude/models and the tool-use /
 * web search docs, then update DEFAULT_MODEL_ID / WEB_SEARCH_TOOL_TYPE below
 * (or just set the ANTHROPIC_MODEL var without redeploying code).
 */

const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
// Per-category display cap on the frontend's own 7 boxes (app.js also
// enforces this client-side). The "All Results" box has no cap — it shows
// every candidate the model returns — so this worker does NOT truncate
// results[key] to MAX_ROWS; it only applies a generous HARD_CAP as an abuse
// guard against a runaway response.
const MAX_ROWS = 15;
const HARD_CAP = 40;
const CATEGORY_LABELS = {
  events: "Events and Tradeshows",
  meetups: "Smaller Group Events",
  newsletters: "Newsletters",
  influencers: "Influencers",
  publications: "Publications",
  syndication: "Other Syndication Platforms",
  social: "Social Media and Blogs",
};
const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);

function corsHeaders(env) {
  const origin = (env.ALLOWED_ORIGIN || "*").trim();
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}

function errorResponse(message, status, env) {
  return jsonResponse({ status: "error", message }, status, env);
}

// Mirrors the validation messages from app.js so a direct API call (not
// just the UI) is still guarded, and error text stays consistent.
function validate({ email, companyUrl, jobTitles }) {
  const jobTitle1 = Array.isArray(jobTitles) && jobTitles.length > 0 ? jobTitles[0] : "";
  const missing = {
    email: !email,
    companyUrl: !companyUrl,
    jobTitle1: !jobTitle1,
  };
  const missingCount = Object.values(missing).filter(Boolean).length;

  if (missingCount === 0) return null;
  if (missingCount >= 2) return "Please Provide Required Information";
  if (missing.email) return "No Email Provided";
  if (missing.jobTitle1) return "One Job Title Is Required";
  if (missing.companyUrl) return "Company URL Is Required";
  return "Please Provide Required Information";
}

function parseAllowedEmails(env) {
  const raw = env.ALLOWED_EMAILS || "";
  return new Set(
    raw
      .split(/[,\n]/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isValidEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeCompanyUrl(raw) {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Best-effort fetch of the company's homepage text as grounding context for
// the model. Non-fatal on failure — the model can still use web search to
// find and read the site itself.
async function fetchCompanySnapshot(companyUrl) {
  try {
    const res = await fetch(companyUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SyndicationEventFinderBot/1.0; +https://twishnoff.github.io/Syndication-And-Events-Finder/)",
      },
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) return "";
    const html = await res.text();
    return stripHtml(html).slice(0, 6000);
  } catch (err) {
    return "";
  }
}

function buildPrompt({ companyUrl, companySnapshot, jobTitles, industry, today }) {
  const jobTitlesList = jobTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const categoryLabelLines = CATEGORY_KEYS.map((key) => `  "${key}" = "${CATEGORY_LABELS[key]}"`).join("\n");

  const system = `You are the research engine behind "Syndication & Event Finder," a tool that helps marketing teams find third-party channels — events, meetups, newsletters, influencers, publications, syndication platforms, and social/blog communities — where they can reach a target audience defined by job title(s) and, optionally, industry.

Your job, given a company's website (its products/services), one to three target job titles, and an optional target industry, is to:

1. Review the company's website/marketing materials (a snapshot of the homepage is provided, and you should use web search to look at more of the site and any comparison/competitor pages) to understand what the company sells, and work out a clean, human-readable company name (not just the domain) for it.
2. Identify similar/competitor companies selling similar products or services, focused on the same industry when one is given. If the company's own site names specific competitors (e.g. on a comparison page), prioritize researching those named competitors' channel activity.
3. Look at the social media, event, and publishing activity of those similar companies: what events/tradeshows they sponsor or attend, what publications quote or feature them, which influencers mention them, what newsletters or webinars they've partnered with. Channels used by similar companies should be weighted higher — but do NOT include a similar company's own owned channels (their blog, their own newsletter, their own YouTube channel, etc.); only third-party channels the company (or its competitors) could partner with, sponsor, or participate in.
4. For each target job title, build a real understanding of the role before searching for channels: think through what that job title is typically responsible for and what their employer expects them to accomplish, the way a current LinkedIn or job-board posting for that title would describe it. Use that understanding — not just the literal words of the job title — to judge whether a channel's audience and subject matter would genuinely help someone doing that job. This job-title understanding should inform your judgment across every category below, not just events.
5. Using all of the above plus the target job title(s) and industry (if given), search the web for candidates in exactly these seven categories:
${CATEGORY_KEYS.map((key) => `   - ${CATEGORY_LABELS[key]}`).join("\n")}

A good candidate is one where the target job title(s) are a primary or strong secondary audience, AND the subject matter is related to what the company sells (the channel doesn't need to be about the company's specific product, but the audience's interest in the channel's subject matter should make them receptive to that product/service). A channel focused on hiring/career-fair purposes for the job title, rather than professional/technical interest relevant to the product, is NOT a good fit even if the job title matches.

Multiple job titles broaden the result set, they don't narrow it: if a channel is a strong fit for only one of the provided job titles, still include it — do not exclude a result just because it doesn't fit every title provided. A channel that appeals to more than one of the provided job titles at once should simply rank higher than one that only fits a single title. The same logic applies to industry: when an industry is provided, an industry-specific channel ranks higher, but a strong industry-agnostic channel that fits the job title(s) is still a valid, valuable result — don't exclude it for lacking an industry focus.

Exclusion rules (apply these before anything else):
- Exclude any channel/event/publication/social account whose name or branding centers on a company that directly competes with the submitted company (e.g. a "<Competitor Name> Meetup" or a blog owned by that competitor), UNLESS it's a large, well-known industry tradeshow/summit run by that competitor (e.g. a major annual summit) — those are fine to include even if the host competes with the submitted company, because they're broad industry events, not a narrow competitor promotion.
- Exclude blogs, social media accounts, and publications that are directly owned/operated by a vendor (whether the submitted company or a competitor) — these are owned channels, not third-party ones, regardless of which company owns them.
- Exclude influencers who are employees of, or exclusively sponsored by/affiliated with, a company that competes with the submitted company.

Rank/prioritize candidates using this order (1 = most important) — this same order determines both which items make each category's top ${MAX_ROWS} and the overall ordering you'll use for the flattened "allResults" list described below:
1. Primary or strong secondary audience alignment with the given job title(s) — channels matching more than one of the provided titles rank above channels matching only one.
2. Subject-matter alignment with the company's products/services/messaging (per the explanation above).
3. Industry alignment, if an industry was provided (industry-agnostic channels are still valid, just rank below a strong industry-specific match).
4. Third-party validation: the channel is linked to/mentioned positively by the company's actual customers, by people with the target job titles, or is used/sponsored by the company's competitors.
5. Timeliness/durability: for events and meetups, only include ones that have not already happened as of ${today} and that are not a one-time/one-off (recurring meetups, annual summits, etc. are good; a single past or one-off event is not). For newsletters/influencers/publications/social channels, prefer ones that have posted/published something recently (roughly the last 48 hours to a few weeks) over ones that appear dormant.

Strict output rules:
- For each category, return every genuinely good candidate you find (there is no fixed cap) — but do not pad with weak or irrelevant results just to lengthen a list; zero is a fine answer for a category with no good fit.
- Every result needs a short "name" (event/newsletter/influencer/publication/platform/channel name) and a "url" that is the real homepage or most relevant page for that result (e.g. the event's homepage, an influencer's channel page, a publication's homepage) — never a search results page.
- Do not include the submitted company's own channels, or channels owned by companies you're using only as comparison points (their blogs, their own newsletters, etc.) — only independent third-party channels — and apply the exclusion rules above.
- Also build a flattened "allResults" array containing every single result from every category combined — ordered purely by how well each one fits the ranking criteria above, across all categories at once (so it is normal, even expected, for the order to interleave categories, e.g. a newsletter, then another newsletter, then an event, then a publication, rather than grouping all of one category together first). Every item in "allResults" needs a "channel" field set to exactly one of these seven labels, matching whichever category it came from:
${categoryLabelLines}
- When you are done researching, respond with ONLY a single JSON object (no prose before or after, no markdown code fences) with exactly this shape:

{
  "companyName": "...",
  "results": {
    "events": [{"name": "...", "url": "..."}],
    "meetups": [{"name": "...", "url": "..."}],
    "newsletters": [{"name": "...", "url": "..."}],
    "influencers": [{"name": "...", "url": "..."}],
    "publications": [{"name": "...", "url": "..."}],
    "syndication": [{"name": "...", "url": "..."}],
    "social": [{"name": "...", "url": "..."}]
  },
  "allResults": [{"name": "...", "url": "...", "channel": "..."}]
}

All seven keys under "results" must always be present, each an array (possibly empty). "allResults" must contain exactly the same items as the seven category arrays combined (just reordered/flattened with a "channel" label added) — don't add or drop anything between the two.`;

  const user = `Company URL: ${companyUrl}

Snapshot of the company's homepage text (may be incomplete or empty — use web search to learn more about the company if needed):
"""
${companySnapshot || "(could not fetch homepage automatically — please look this company up yourself)"}
"""

Target job title(s):
${jobTitlesList}

Target industry: ${industry || "(none specified — do not restrict by industry, but still apply the general prioritization rules)"}

Today's date: ${today}

Research and return the JSON object described in your instructions now.`;

  return { system, user };
}

async function callClaude(env, system, userText) {
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL_ID;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      // Higher than before: the response now also includes a flattened
      // "allResults" array duplicating every category item, and categories
      // are no longer capped at 15 before that flattening happens.
      max_tokens: 16000,
      system,
      tools: [
        {
          type: WEB_SEARCH_TOOL_TYPE,
          name: "web_search",
          max_uses: 12,
        },
      ],
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text);
  return textBlocks.join("\n").trim();
}

function extractJsonObject(text) {
  // Strip markdown code fences if the model added them despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  try {
    return JSON.parse(candidate);
  } catch (err) {
    // Fall back to grabbing the outermost {...} block.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (err2) {
      return null;
    }
  }
}

function isCleanItem(item) {
  return Boolean(item && typeof item.name === "string" && item.name.trim() && typeof item.url === "string" && item.url.trim());
}

function sanitizeResults(raw) {
  const rawResults = (raw && raw.results) || {};
  const clean = {};
  for (const key of CATEGORY_KEYS) {
    const list = Array.isArray(rawResults[key]) ? rawResults[key] : [];
    clean[key] = list
      .filter(isCleanItem)
      .slice(0, HARD_CAP)
      .map((item) => ({ name: item.name.trim(), url: item.url.trim() }));
  }
  return clean;
}

function sanitizeAllResults(raw, resultsClean) {
  const rawAll = Array.isArray(raw && raw.allResults) ? raw.allResults : [];
  const validLabels = new Set(Object.values(CATEGORY_LABELS));
  const clean = rawAll
    .filter((item) => isCleanItem(item) && typeof item.channel === "string" && validLabels.has(item.channel))
    .slice(0, HARD_CAP * CATEGORY_KEYS.length)
    .map((item) => ({ name: item.name.trim(), url: item.url.trim(), channel: item.channel }));

  if (clean.length > 0) return clean;

  // Fall back to flattening the (already-clean) per-category results in
  // category order if the model didn't produce a usable allResults array.
  const fallback = [];
  for (const key of CATEGORY_KEYS) {
    (resultsClean[key] || []).forEach((item) => {
      fallback.push({ name: item.name, url: item.url, channel: CATEGORY_LABELS[key] });
    });
  }
  return fallback;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== "POST") {
      return errorResponse("Method not allowed.", 405, env);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return errorResponse("Backend is misconfigured (missing ANTHROPIC_API_KEY).", 500, env);
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return errorResponse("Invalid request body.", 400, env);
    }

    const email = (body.email || "").trim();
    const companyUrlRaw = (body.companyUrl || "").trim();
    const jobTitles = Array.isArray(body.jobTitles) ? body.jobTitles.filter(Boolean) : [];
    const industry = (body.industry || "").trim();
    const today = (body.today || new Date().toISOString().slice(0, 10)).trim();

    const validationError = validate({ email, companyUrl: companyUrlRaw, jobTitles });
    if (validationError) {
      return errorResponse(validationError, 400, env);
    }

    if (!isValidEmailFormat(email)) {
      return errorResponse("Please enter a valid email address.", 400, env);
    }

    const allowedEmails = parseAllowedEmails(env);
    if (allowedEmails.size > 0 && !allowedEmails.has(email.toLowerCase())) {
      return errorResponse(
        "This email isn't on the approved list yet. Contact the site owner for access.",
        403,
        env
      );
    }

    const companyUrl = normalizeCompanyUrl(companyUrlRaw);
    const companySnapshot = await fetchCompanySnapshot(companyUrl);

    const { system, user } = buildPrompt({
      companyUrl,
      companySnapshot,
      jobTitles: jobTitles.slice(0, 3),
      industry,
      today,
    });

    let modelText;
    try {
      modelText = await callClaude(env, system, user);
    } catch (err) {
      return errorResponse(
        "Could not reach the research service right now. Please try again in a moment.",
        502,
        env
      );
    }

    const parsed = extractJsonObject(modelText);
    if (!parsed) {
      return errorResponse("Could not parse research results. Please try again.", 502, env);
    }

    const results = sanitizeResults(parsed);
    const allResults = sanitizeAllResults(parsed, results);
    const companyName =
      typeof parsed.companyName === "string" && parsed.companyName.trim() ? parsed.companyName.trim() : null;

    return jsonResponse({ status: "ok", companyName, results, allResults }, 200, env);
  },
};
