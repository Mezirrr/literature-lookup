import { createClient } from '@supabase/supabase-js';

// Initialize Supabase for the backend. 
// Make sure to add these to your Vercel Environment Variables.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use Service Role Key for backend overrides
const supabase = createClient(supabaseUrl, supabaseKey);

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ==========================================
  // PHASE 0: Security & Tier Enforcement
  // ==========================================
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Please log in to run an assay.' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session.' });
  }

  // Check user tier and usage
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('tier, assays_used_this_month')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(500).json({ error: 'Could not fetch user profile limits.' });
  }

  // Define tier limits
  const tierLimits = {
    'Free': 5,
    'Mini': 50,
    'Max': 500
  };

  const currentLimit = tierLimits[profile.tier] || 0;
  if (profile.assays_used_this_month >= currentLimit) {
    return res.status(403).json({ 
      error: `Limit reached. Your ${profile.tier} tier allows ${currentLimit} assays per month.` 
    });
  }

  // Proceed with standard payload
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
    // PHASE 2: Sequential Semantic Scholar Fetching
    // ==========================================
    let allRealPapers = [];
    let fallbackTriggered = false;

    for (let i = 0; i < targetsArray.length; i++) {
      const singleTarget = targetsArray[i];
      
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

        if (papers.length === 0) {
          fallbackTriggered = true;
          await new Promise(resolve => setTimeout(resolve, 1200)); 
          
          const fallbackQuery = singleTarget;
          const fallbackUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(fallbackQuery)}&limit=15&fields=paperId,title,url,year,abstract`;
          
          s2Res = await fetchWithRetry(fallbackUrl, {
            headers: { 'x-api-key': s2ApiKey }
          }, 1, 6000);
          
          s2Data = await s2Res.json();
          papers = s2Data.data || [];
        }

        const mappedPapers = papers.map(p => ({
          title: p.title || 'Unknown Title',
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
}`;

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

    if (finalJson.results && Array.isArray(finalJson.results)) {
      finalJson.results.forEach(res => { res.source = "Semantic Scholar"; });
    }

    // ==========================================
    // PHASE 4: Update Database Usage 
    // ==========================================
    // If we made it this far successfully, dock one credit
    await supabase
      .from('profiles')
      .update({ assays_used_this_month: profile.assays_used_this_month + 1 })
      .eq('id', user.id);

    res.status(200).json(finalJson);

  } catch (error) {
    console.error("API Pipeline Error:", error);
    res.status(500).json({ 
      error: "The analysis pipeline encountered a network instability or failed after multiple retries. Please try again." 
    });
  }
}
