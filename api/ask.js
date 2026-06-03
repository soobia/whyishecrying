export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question } = req.body;

  if (!question || typeof question !== 'string' || question.length > 500) {
    return res.status(400).json({ error: 'Invalid question' });
  }

  const q = question.toLowerCase();

  // ── CACHE TIER DETECTION ──
  const isLive = [
    'today', 'tonight', 'now', 'just', 'latest', 'current', 'right now',
    'this morning', 'last night', 'yesterday', 'just happened', 'score',
    'result', 'who won', 'did they win', 'live', 'happening', 'ongoing',
    'this match', 'the game today', 'just scored', 'breaking'
  ].some(kw => q.includes(kw));

  const isPlayerOrTeam = [
    'who is', 'who are', 'how is', 'how are', 'injured', 'injury',
    'playing tonight', 'starting', 'lineup', 'squad', 'roster', 'form',
    'captain', 'manager', 'coach', 'transfer', 'suspended'
  ].some(kw => q.includes(kw));

  // Never cache live questions. Cache rules forever, player/team for 6 hours.
  const cacheTTL = isLive ? 0 : isPlayerOrTeam ? 21600 : 2592000; // 0, 6hrs, 30 days

  const cacheKey = 'q:' + q.trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_').slice(0, 100);

  const redisUrl = process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  // ── CHECK CACHE (skip for live questions) ──
  if (!isLive && redisUrl && redisToken) {
    try {
      const cacheRes = await fetch(`${redisUrl}/get/${encodeURIComponent(cacheKey)}`, {
        headers: { Authorization: `Bearer ${redisToken}` }
      });
      const cacheData = await cacheRes.json();
      if (cacheData.result) {
        const cached = JSON.parse(cacheData.result);
        return res.status(200).json({ answer: cached.answer, fromCache: true });
      }
    } catch (err) {
      console.error('Cache read error:', err);
    }
  }

  const SYSTEM_PROMPT = `You are a soccer explainer for American first-time fans watching the World Cup.

PERSONALITY — match your tone to the question being asked:
- Rules/basics questions ("what is offside", "how does VAR work"): Be warm and patient, like a knowledgeable friend who never makes someone feel dumb for not knowing. Build from the basics up.
- Big moment questions ("why did that goal get disallowed", "what just happened", questions with caps or exclamation points): Match their energy. Be hyped, enthusiastic, use exclamation points. Make it feel like you're watching together.
- Drama/controversy questions ("why do players fake injuries", "that ref was wrong", "that's unfair"): Dry humor, slightly sarcastic, funny analogies. Acknowledge the drama.
- Player/team questions: Conversational sports bar tone, like a buddy who knows the game inside out.

RULES:
- Answer ONLY questions about soccer/football, the World Cup, and related topics.
- For off-topic questions, say: "I only answer soccer questions! Ask me anything about the World Cup."
- Keep answers under 150 words.
- NEVER ask clarifying questions. If a question is ambiguous (e.g. men vs women, which team, which match), just answer covering all relevant cases briefly.
- ALWAYS use at least one analogy from American sports (NFL, NBA, MLB, or NHL).
- Use plain, casual American English. No jargon without explanation.
- Never be condescending about the person not knowing soccer.
- If asked about a current match, recent event, player news, injuries, rosters, scores, or anything time-sensitive, use your web search tool to get the latest information BEFORE answering.
- Format: plain text, no markdown, no bullet points. Just 2-3 short punchy paragraphs.
- NEVER narrate your search process. Never say "I need to search" or "let me look that up." Just answer naturally.`;

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
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: question }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(500).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const answer = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .trim() || 'Sorry, I could not generate an answer.';

    // ── SAVE TO CACHE (skip live questions) ──
    if (!isLive && redisUrl && redisToken && cacheTTL > 0) {
      try {
        await fetch(`${redisUrl}/set/${encodeURIComponent(cacheKey)}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${redisToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ value: JSON.stringify({ answer, question }), ex: cacheTTL })
        });
      } catch (err) {
        console.error('Cache write error:', err);
      }
    }

    return res.status(200).json({ answer });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
