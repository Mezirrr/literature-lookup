export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal, typeLabel } = req.body;

  try {
    // Phase 1: Use the AI to expand queries and think laterally before hitting PubMed
    const queryExpansionPrompt = `You are an elite biochemical intelligence engine. The user has a research target and a lateral discovery goal.
Target: ${target}
Goal: ${goal}

Generate a clean, professional, unquoted PubMed/EuropePMC search query optimized to catch cross-disciplinary and mechanistic connections. 
- Do not include conversational filler.
- Use boolean operators (AND, OR) and clean keyword groupings.
- Focus on underlying pathways, target receptors, and physiological mechanisms.
- Keep the total length concise enough for an API query.

Respond with ONLY the raw query string.`;

    const expansionRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b', 
        messages: [{ role: 'user', content: queryExpansionPrompt }]
      })
    });

    const expansionData = await expansionRes.json();
    let optimizedQuery = `${target} ${goal}`.trim();
    if (expansionData.choices && expansionData.choices.length > 0) {
      optimizedQuery = expansionData.choices[0].message.content.trim().replace(/^"|"$/g, '');
    }

    // Phase 2: Fetch papers using the smart query
    const pmcRes = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(optimizedQuery)}&format=json&resultType=core&pageSize=25`);
    const pmcData = await pmcRes.json();

    let realPapers = [];
    if (pmcData.resultList && pmcData.resultList.result) {
      realPapers = pmcData.resultList.result.map(p => ({
        title: p.title,
        url: p.doi ? `https://doi.org/${p.doi}` : `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
        year: p.pubYear,
        abstract: p.abstractText ? p.abstractText.substring(0, 400) + '...' : 'No abstract available'
      }));
    }

    // Phase 3: Run the core high-IQ synthesis evaluation
    const systemPrompt = `You are an elite, highly open-minded scientific research assistant specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task is twofold:
1. Under "directResponse", provide a deep, high-IQ direct response explaining the conceptual, structural, biochemical, or clinical connection between the user's target and their goal. Even if zero literature matches are supplied below, use your extensive core knowledge to explore non-obvious pathways, lateral links, and theories.
2. Evaluate the provided list of papers (if any) and select the top 8 most useful ones. Write a strict maximum 18-word "relevance" explanation for each, revealing how it cross-links the target to the goal.

Respond with ONLY raw JSON matching exactly this schema:
{
  "directResponse": "string (Deep-dive synthesis, mechanistic cross-linking explanation, and insights written directly to the researcher)",
  "results": [
    {
      "title": "string",
      "url": "string",
      "source": "PubMed",
      "year": "string",
      "relevance": "string"
    }
  ]
}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}\nTarget: ${target}\nGoal: ${goal || 'General info'}\n\nHere are the real papers found via search term [${optimizedQuery}]:\n${JSON.stringify(realPapers, null, 2)}\n\nFilter and return the JSON.`;

    const groqRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
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
    });

    const groqData = await groqRes.json();
    
    if (groqData.error) {
       console.error("GROQ API ERROR:", JSON.stringify(groqData.error, null, 2));
       throw new Error(`Groq rejected the request: ${groqData.error.message}`);
    }
    
    const text = groqData.choices[0].message.content;
    const finalData = JSON.parse(text);

    res.status(200).json(finalData);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
