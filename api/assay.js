export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal, typeLabel } = req.body;

  try {
    // 1. Fetch REAL papers from Semantic Scholar
    const searchQuery = `${target} ${goal}`.trim();
    const scholarRes = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(searchQuery)}&limit=15&fields=title,url,year,abstract`);
    const scholarData = await scholarRes.json();

    if (!scholarData.data || scholarData.data.length === 0) {
       return res.status(200).json({ results: [] });
    }

    // Format the real papers to show to Gemini
    const realPapers = scholarData.data.map(p => ({
        title: p.title,
        url: p.url,
        year: p.year,
        abstract: p.abstract ? p.abstract.substring(0, 300) + '...' : 'No abstract'
    }));

    // 2. Send the REAL papers to Gemini to evaluate
    const systemPrompt = `You are a scientific literature assistant. I will provide you with a list of REAL academic papers pulled from a database. 
Your job is to evaluate which ones actually match the user's research goal, select the top 8, and write a strict maximum 18-word "relevance" explanation for why it matters to their goal.

Respond with ONLY raw JSON matching exactly this schema:
{"results":[{"title":"string","url":"string","source":"Semantic Scholar","year":"string","relevance":"string"}]}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}\nTarget: ${target}\nGoal: ${goal || 'General info'}\n\nHere are the real papers I found:\n${JSON.stringify(realPapers, null, 2)}\n\nFilter and return the JSON.`;

    // Make the request to Google's Gemini API
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json" // Forces Gemini to return perfect JSON
        }
      })
    });

    const geminiData = await geminiRes.json();
    
    if (!geminiData.candidates || geminiData.candidates.length === 0) {
       throw new Error("Gemini did not return a valid response.");
    }
    
    // Extract and parse the JSON Gemini spits out
    const text = geminiData.candidates[0].content.parts[0].text;
    const finalData = JSON.parse(text);

    // 3. Send back to your frontend
    res.status(200).json(finalData);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
