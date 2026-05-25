export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question } = req.body;

  if (!question || typeof question !== 'string' || question.length > 500) {
    return res.status(400).json({ error: 'Invalid question' });
  }

  const SYSTEM_PROMPT = `You are a soccer explainer for American first-time fans watching the World Cup.

RULES:
- Answer ONLY questions about soccer/football, the World Cup, and related topics.
- For off-topic questions, say: "I only answer soccer questions! Ask me anything about the World Cup."
- Keep answers under 120 words.
- ALWAYS use at least one analogy from American sports (NFL, NBA, MLB, or NHL).
- Use plain, casual American English. No jargon without explanation.
- Be direct and slightly enthusiastic — like a friend who loves soccer explaining it.
- Never be condescending about the person not knowing soccer.
- Format: plain text, no markdown, no bullet points. Just 2-3 short punchy paragraphs.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: question }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(500).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const answer = data.content?.[0]?.text || 'Sorry, I could not generate an answer.';

    return res.status(200).json({ answer });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
