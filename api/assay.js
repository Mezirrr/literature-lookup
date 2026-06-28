export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal, typeLabel } = req.body;

  try {
    // 1. Fetch REAL papers from Europe PMC (PubMed)
    const searchQuery = `${target} ${goal}`.trim();
    const pmcRes = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&format=json&resultType=core&pageSize=15`);
    const pmcData = await pmcRes.json();

    if (!pmcData.resultList || !pmcData.resultList.result || pmcData.resultList.result.length === 0) {
       return res.status(200).json({ results: [] });
    }

    // Format the real papers to show to Groq
    const realPapers = pmcData.resultList.result.map(p => ({
        title: p.title,
        url: p.doi ? `https://doi.org/${p.doi}` : `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
        year: p.pubYear,
        abstract: p.abstractText ? p.abstractText.substring(0, 300) + '...' : 'No abstract'
    }));

    // 2. Send the REAL papers to Groq to evaluate
    const systemPrompt = `You are a scientific literature assistant. I will provide you with a list of REAL academic papers pulled from PubMed/Europe PMC. 
Your job is to evaluate which ones actually match the user's research goal, select the top 8, and write a strict maximum 18-word "relevance" explanation for why it matters to their goal.

Respond with ONLY raw JSON matching exactly this schema:
{"results":[{"title":"string","url":"string","source":"PubMed","year":"string","relevance":"string"}]}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}\nTarget: ${target}\nGoal: ${goal || 'General info'}\n\nHere are the real papers I found:\n${JSON.stringify(realPapers, null, 2)}\n\nFilter and return the JSON.`;

    // Make the request to Groq's API using the high-IQ OpenAI 120B model
    const groqRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b', // Changed right here
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' } 
      })
    });

    const groqData = await groqRes.json();
    
    // Catch Groq specific errors
    if (groqData.error) {
       console.error("GROQ API ERROR:", JSON.stringify(groqData.error, null, 2));
       throw new Error(`Groq rejected the request: ${groqData.error.message}`);
    }
    
    if (!groqData.choices || groqData.choices.length === 0) {
       console.error("GROQ BLOCKED RESPONSE:", JSON.stringify(groqData, null, 2));
       throw new Error("Groq returned an empty response.");
    }
    
    // Extract and parse the JSON Groq spits out
    const text = groqData.choices[0].message.content;
    const finalData = JSON.parse(text);

    // 3. Send back to your frontend
    res.status(200).json(finalData);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
