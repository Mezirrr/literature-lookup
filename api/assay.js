import { createClient } from '@supabase/supabase-js';

// Admin client — uses the SERVICE ROLE key so it can read/write any user's
// profile row regardless of Row Level Security policies. Never expose this
// key to the browser; it only belongs here, in server-side code.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TIER_LIMITS = { Free: 5, Mini: 50, Max: 1000 };
const PROFILE_SYNTHESIS_EVERY = 5; // regenerate the rolling researcher profile every N searches

// Smart Fetch Wrapper with Timeout and Retry Logic
async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 8000) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (i === retries) {
        console.warn(`Request failed after ${retries} retries: ${url}`);
        throw error;
      }
      // Exponential backoff for retries
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

function currentPeriod() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

// Reads the last 5 searches for a user and asks the model for a terse
// 50-word synthesis of their research focus. Stores it on the profile row
// so future Phase 3 calls can silently bias their analysis toward it.
async function maybeUpdateResearcherProfile(userId, newSearchCount) {
  if (newSearchCount % PROFILE_SYNTHESIS_EVERY !== 0) return;

  const { data: recentSearches } = await supabaseAdmin
    .from('search_history')
    .select('target_searched, goal_input')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (!recentSearches || recentSearches.length === 0) return;

  const historyText = recentSearches
    .map((s, i) => `${i + 1}. Target(s): ${s.target_searched} | Goal: ${s.goal_input || 'n/a'}`)
    .join('\n');

  const profilerSystemPrompt = `You write extremely terse internal researcher-focus summaries for an analytics system. Given a list of a single user's recent search queries on a biomedical research tool, output ONLY a single plain-text synthesis, 50 words maximum, describing their recurring pathways of interest and likely underlying motive. No preamble, no JSON, no markdown.`;

  try {
    const profilerRes = await fetchWithRetry(`https://api.groq.com/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: profilerSystemPrompt },
          { role: 'user', content: historyText }
        ]
      })
    }, 1, 6000);

    const profilerData = await profilerRes.json();
    const synthesis = profilerData?.choices?.[0]?.message?.content?.trim();

    if (synthesis) {
      await supabaseAdmin.from('profiles').update({ researcher_profile: synthesis }).eq('id', userId);
    }
  } catch (e) {
    console.warn('Researcher profile synthesis skipped/failed:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ==========================================
  // GATEKEEPER: Auth & Tier Limit Validation
  // ==========================================
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({ error: 'Profile not found. Please re-register your account.' });
  }

  // Lazy monthly reset: if the stored usage_period doesn't match the
  // current calendar month, treat usage as 0 without needing a cron job.
  const period = currentPeriod();
  const assaysUsedThisMonth = profile.usage_period === period ? profile.assays_used_this_month : 0;

  const limit = TIER_LIMITS[profile.tier] || TIER_LIMITS.Free;
  if (assaysUsedThisMonth >= limit) {
    return res.status(403).json({
      error: `Access Denied: You have reached your ${profile.tier} tier limit of ${limit} assays this month. Please upgrade your permissions to continue.`
    });
  }

  // Proceed with Engine Logic if limits are clear
  const { target, goal, typeLabel } = req.body;

  try {
    const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);

    if (targetsArray.length === 0) {
      return res.status(400).json({ error: 'No valid targets provided.' });
    }

    const targetsHeading = targetsArray.join(', ');
    const s2ApiKey = "s2k-zRgzPNUsqrylk6ST4j78YbPFDcq74woh6HR4Uawp"; // Consider moving to process.env.S2_API_KEY later

    // ==========================================
    // PHASE 1: Internal Pre-Enhancer
    // Reframes vague inputs into optimized Semantic Scholar search strings
    // ==========================================
    const enhancerSystemPrompt = `You are an elite biochemical intelligence engine. Optimize the user's inputs for Semantic Scholar literature retrieval.
Respond ONLY with JSON matching this schema:
{
  "enhancedGoal": "A hyper-technical reframing of the user's goal (max 2 sentences).",
  "optimizedQueries": {
    "TargetName1": "Semantic keyword string (no complex boolean). E.g., 'TargetName mechanism of action pathway'",
    "TargetName2": "..."
  }
}`;

    const enhancerUserPrompt = `Targets: ${targetsHeading}\nRaw Goal: ${goal || 'General pharmacological profile and mechanisms'}`;

    let enhancedGoal = goal;
    let optimizedQueries = {};

    try {
      const enhancerRes = await fetchWithRetry(`https://api.groq.com/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: enhancerSystemPrompt },
            { role: 'user', content: enhancerUserPrompt }
          ],
          response_format: { type: 'json_object' }
        })
      }, 2, 6000);

      const enhancerData = await enhancerRes.json();
      const enhancerJson = JSON.parse(enhancerData.choices[0].message.content);

      enhancedGoal = enhancerJson.enhancedGoal || goal;
      optimizedQueries = enhancerJson.optimizedQueries || {};
    } catch (e) {
      console.warn("Internal Enhancer skipped/failed, falling back to raw strings.", e.message);
    }

    // ==========================================
    // PHASE 2: Sequential Semantic Scholar Fetching (1 RPS Rate Limit Guard)
    // ==========================================
    let allRealPapers = [];
    let fallbackTriggered = false;

    // We MUST use a standard for-loop here to await the delay between iterations
    for (let i = 0; i < targetsArray.length; i++) {
      const singleTarget = targetsArray[i];

      // Delay to respect 1 RPS limit (Wait 1.2 seconds if not the first request)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1200));
      }

      let optimizedQuery = optimizedQueries[singleTarget] || `${singleTarget} ${enhancedGoal}`.trim();
      let s2Url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(optimizedQuery)}&limit=15&fields=paperId,title,url,year,abstract,authors`;

      try {
        let s2Res = await fetchWithRetry(s2Url, {
          headers: { 'x-api-key': s2ApiKey }
        }, 1, 6000);

        let s2Data = await s2Res.json();
        let papers = s2Data.data || [];

        // SMART FALLBACK: If query was too strict, loosen it.
        if (papers.length === 0) {
          fallbackTriggered = true;
          // Must wait again before firing the fallback to respect the 1 RPS limit
          await new Promise(resolve => setTimeout(resolve, 1200));

          const fallbackQuery = singleTarget;
          const fallbackUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(fallbackQuery)}&limit=15&fields=paperId,title,url,year,abstract`;

          s2Res = await fetchWithRetry(fallbackUrl, {
            headers: { 'x-api-key': s2ApiKey }
          }, 1, 6000);

          s2Data = await s2Res.json();
          papers = s2Data.data || [];
        }

        // Map Semantic Scholar payload to our standardized schema
        const mappedPapers = papers.map(p => ({
          title: p.title || 'Unknown Title',
          // S2 sometimes leaves URL null, so we build it dynamically using the paperId
          url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
          year: p.year || 'Unknown',
          abstract: p.abstract ? p.abstract.substring(0, 400) + '...' : 'No abstract available',
          associatedTarget: singleTarget
        })).filter(p => p.url);

        allRealPapers.push(...mappedPapers);

      } catch (err) {
        console.warn(`Semantic Scholar fetch failed for target: ${singleTarget}`, err.message);
      }
    }

    const seenUrls = new Set();
    const uniquePapers = allRealPapers.filter(p => {
      if (!p.url || seenUrls.has(p.url)) return false;
      seenUrls.add(p.url);
      return true;
    }).slice(0, 35);

    // ==========================================
    // PHASE 3: Dynamic Multi-Target Synthesis
    // ==========================================
    const researcherContext = profile.researcher_profile
      ? `\n\nKnown Researcher Focus Profile (derived from this user's last several searches — use it to silently tailor the depth/angle of your analysis and follow-up questions toward their underlying motive, but do not restate it verbatim): ${profile.researcher_profile}`
      : '';

    const systemPrompt = `You are a 130-IQ, elite biochemical intelligence architecture specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task is:
1. Under "directResponse", provide a hyper-analytical, flawlessly logical 130-IQ synthesis explaining the conceptual, structural, biochemical, or clinical connection between the user's targets (${targetsHeading}) and their discovery goal.
   - Strike an authoritative, deeply academic, and highly technical tone. Avoid fluff, unnecessary introductory pleasantries, and thesaurus-bloat.
   - Map out explicit synergistic actions, shared metabolic pathways, or direct ligand-receptor convergence points.
   - Detail the exact molecular mechanisms behind any combined toxicities or emergent pharmacological properties.
2. Under "followUpOptions", provide exactly 3 deeply analytical, highly insightful follow-up questions (strings) investigating cascading enzymatic steps or structural affinities. Max 12 words each.
3. Select the top relevant papers (up to 15).
   - Write a strict max 18-word "relevance" explanation for each, explicitly linking its findings to the target matrix.
   - Classify "studyType" strictly as: "In Vitro", "In Vivo", or "Human". Default to "In Vivo" if ambiguous.

Respond with ONLY raw JSON matching exactly this schema:
{
  "directResponse": "string",
  "followUpOptions": ["string", "string", "string"],
  "results": [
    {
      "title": "string",
      "url": "string",
      "source": "Semantic Scholar",
      "year": "string",
      "relevance": "string",
      "studyType": "In Vitro | In Vivo | Human"
    }
  ]
}${researcherContext}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}
All Inputs Requested: ${targetsHeading}
Original Goal: ${goal || 'General info'}
Enhanced Analytical Context: ${enhancedGoal}
Is Fallback Broad Search Active: ${fallbackTriggered}

Here are the real compiled papers found across targets:
${JSON.stringify(uniquePapers, null, 2)}

Filter and return the JSON.`;

    const groqRes = await fetchWithRetry(`https://api.groq.com/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      })
    }, 2, 12000);

    const groqData = await groqRes.json();
    const text = groqData.choices[0].message.content;

    const finalJson = JSON.parse(text);
    finalJson.isFallback = fallbackTriggered;

    // Explicitly enforce the source naming for UI rendering
    if (finalJson.results && Array.isArray(finalJson.results)) {
      finalJson.results.forEach(r => { r.source = "Semantic Scholar"; });
    }

    // ==========================================
    // GATEKEEPER UPDATE: Log History, Increment Usage, Refresh Researcher Profile
    // ==========================================
    const newSearchCount = (profile.search_count || 0) + 1;

    await supabaseAdmin.from('profiles').update({
      assays_used_this_month: assaysUsedThisMonth + 1,
      usage_period: period,
      search_count: newSearchCount
    }).eq('id', user.id);

    await supabaseAdmin.from('search_history').insert([
      { user_id: user.id, target_searched: targetsHeading, goal_input: goal }
    ]);

    // Runs synchronously every 5th search; adds latency only on that request.
    await maybeUpdateResearcherProfile(user.id, newSearchCount);

    res.status(200).json(finalJson);

  } catch (error) {
    console.error("API Pipeline Error:", error);
    res.status(500).json({
      error: "The analysis pipeline encountered a network instability or failed after multiple retries. Please try again."
    });
  }
}
