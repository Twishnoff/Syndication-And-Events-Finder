/**
 * Syndication & Event Finder — Cloudflare Worker backend
 * -------------------------------------------------------
 * Implements the research/ranking logic described in the spec doc:
 * given a company URL, up to three job titles, and an optional industry,
 * it researches the company, finds similar/competitor companies, and
 * searches the web for events, meetups, newsletters, influencers,
 * publications, syndication platforms, and social/blog channels that
 * would reach that audience — then ranks and returns up to 15 results
 * per category in the exact JSON shape the frontend (app.js) expects.
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
const MAX_ROWS = 15;
const CATEGORY_KEYS = [
  "events",
  "meetups",
  "newsletters",
  "influencers",
  "publications",
  "syndication",
  "social",
];

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

  const system = `You are the research engine behind "Syndication & Event Finder," a tool that helps marketing teams find third-party channels — events, meetups, newsletters, influencers, publications, syndication platforms, and social/blog communities — where they can reach a target audience defined by job title(s) and, optionally, industry.

Your job, given a company's website (its products/services), one to three target job titles, and an optional target industry, is to:

1. Review the company's website/marketing materials (a snapshot of the homepage is provided, and you should use web search to look at more of the site and any comparison/competitor pages) to understand what the company sells.
2. Identify similar/competitor companies selling similar products or services, focused on the same industry when one is given. If the company's own site names specific competitors (e.g. on a comparison page), prioritize researching those named competitors' channel activity.
3. Look at the social media, event, and publishing activity of those similar companies: what events/tradeshows they sponsor or attend, what publications quote or feature them, which influencers mention them, what newsletters or webinars they've partnered with. Channels used by similar companies should be weighted higher — but do NOT include a similar company's own owned channels (their blog, their own newsletter, their own YouTube channel, etc.); only third-party channels the company (or its competitors) could partner with, sponsor, or participate in.
4. Using all of the above plus the target job title(s) and industry (if given), search the web for candidates in exactly these seven categories:
   - Large Events and Tradeshows
   - Meetups or Smaller Group Events
   - Newsletters
   - Popular Influencers
   - Publishers/Publications (online or print — e.g. trade press, industry blogs with editorial staff)
   - Other Syndication Platforms (paid access to an audience: webinar series, partner networks, sponsorship platforms, etc.)
   - Social Media and Blogs (e.g. Reddit communities, Medium/Substack publications, LinkedIn groups — places the target audience actually reads/watches/listens)

A good candidate is one where the target job title(s) are a primary or strong secondary audience, AND the subject matter is related to what the company sells (the channel doesn't need to be about the company's specific product, but the audience's interest in the channel's subject matter should make them receptive to that product/service). A channel focused on hiring/career-fair purposes for the job title, rather than professional/technical interest relevant to the product, is NOT a good fit even if the job title matches. When an industry is given, prefer industry-specific channels, but don't discard a strong industry-agnostic channel just because it isn't industry-specific — rank it slightly lower instead of excluding it.

Rank/prioritize candidates within each category using this order (1 = most important) when you have more than ${MAX_ROWS} good candidates for a category:
1. Primary or strong secondary audience alignment with the given job title(s) (or the majority of them, if more than one was given).
2. Subject-matter alignment with the company's products/services/messaging (per the explanation above).
3. Industry alignment, if an industry was provided.
4. Third-party validation: the channel is linked to/mentioned positively by the company's actual customers, by people with the target job titles, or is used/sponsored by the company's competitors.
5. Timeliness/durability: for events and meetups, only include ones that have not already happened as of ${today} and that are not a one-time/one-off (recurring meetups, annual summits, etc. are good; a single past or one-off event is not). For newsletters/influencers/publications/social channels, prefer ones that have posted/published something recently (roughly the last 48 hours to a few weeks) over ones that appear dormant.

Strict output rules:
- Return AT MOST ${MAX_ROWS} results per category. Fewer (including zero) is fine and expected if you can't find that many genuinely good fits — do not pad with weak or irrelevant results just to fill the list.
- Every result needs a short "name" (event/newsletter/influencer/publication/platform/channel name) and a "url" that is the real homepage or most relevant page for that result (e.g. the event's homepage, an influencer's channel page, a publication's homepage) — never a search results page.
- Do not include the submitted company's own channels, or channels owned by companies you're using only as comparison points (their blogs, their own newsletters, etc.) — only independent third-party channels.
- When you are done researching, respond with ONLY a single JSON object (no prose before or after, no markdown code fences) with exactly this shape:

{
  "results": {
    "events": [{"name": "...", "url": "..."}],
    "meetups": [{"name": "...", "url": "..."}],
    "newsletters": [{"name": "...", "url": "..."}],
    "influencers": [{"name": "...", "url": "..."}],
    "publications": [{"name": "...", "url": "..."}],
    "syndication": [{"name": "...", "url": "..."}],
    "social": [{"name": "...", "url": "..."}]
  }
}

All seven keys must always be present, each an array (possibly empty).`;

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
      max_tokens: 8000,
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

function sanitizeResults(raw) {
  const rawResults = (raw && raw.results) || {};
  const clean = {};
  for (const key of CATEGORY_KEYS) {
    const list = Array.isArray(rawResults[key]) ? rawResults[key] : [];
    clean[key] = list
      .filter((item) => item && typeof item.name === "string" && typeof item.url === "string" && item.url.trim())
      .slice(0, MAX_ROWS)
      .map((item) => ({ name: item.name.trim(), url: item.url.trim() }));
  }
  return clean;
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

    return jsonResponse({ status: "ok", results }, 200, env);
  },
};
