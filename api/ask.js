// Words to ignore when extracting topic from question
const STOP_WORDS = new Set([
  'what','is','are','was','were','how','does','do','did','why','who','when','where',
  'which','can','could','would','should','will','the','a','an','in','on','at','to',
  'for','of','and','or','but','not','it','its','this','that','these','those','my',
  'me','i','you','we','they','he','she','tell','explain','describe','about','give',
  'please','help','understand','know','think','mean','means','called','call','want',
  'make','makes','happen','happens','happened','go','goes','get','gets','just','like',
  'than','then','so','if','be','been','being','have','has','had','with','from','by',
  'as','up','out','into','through','during','before','after','between','each','few',
  'more','most','other','some','such','no','nor','own','same','too','very','also'
]);

function extractTopics(question) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(' ')
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .sort()
    .join('-');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question } = req.body;

  if (!question || typeof question !== 'string' || question.length > 500) {
    return res.status(400).json({ error: 'Invalid question' });
  }

  const q = question.toLowerCase().trim();

  // ── CACHE TIER DETECTION ──
  const liveKeywords = [
    'today', 'tonight', 'now', 'just', 'latest', 'current', 'right now',
    'this morning', 'last night', 'yesterday', 'score', 'result', 'who won',
    'did they win', 'live', 'happening', 'ongoing', 'just scored', 'breaking',
    'this match', 'the game today'
  ];

  const playerKeywords = [
    'who is', 'who are', 'how is', 'how are', 'injured', 'injury',
    'playing tonight', 'starting', 'lineup', 'squad', 'roster',
    'form', 'manager', 'coach', 'transfer', 'suspended'
  ];

  const isLive = liveKeywords.some(kw => q.includes(kw));
  const isPlayerOrTeam = !isLive && playerKeywords.some(kw => q.includes(kw));
  const cacheTTL = isLive ? 0 : isPlayerOrTeam ? 21600 : 2592000;

  // Build cache key from extracted topics -- same topics = same key regardless of phrasing
  const topicKey = extractTopics(question);
  const cacheKey = 'q:' + topicKey;

  const redisUrl = process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  // ── CHECK CACHE ──
  // Only use cache if we extracted at least 1 meaningful topic word
  const hasMeaningfulTopics = topicKey.length > 2;

  if (!isLive && hasMeaningfulTopics && redisUrl && redisToken) {
    try {
      const cacheRes = await fetch(`${redisUrl}/get/${encodeURIComponent(cacheKey)}`, {
        headers: { Authorization: `Bearer ${redisToken}` }
      });
      if (cacheRes.ok) {
        const cacheData = await cacheRes.json();
        if (cacheData.result) {
          return res.status(200).json({ answer: cacheData.result, fromCache: true });
        }
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

    // ── SAVE TO CACHE ──
    if (!isLive && cacheTTL > 0 && hasMeaningfulTopics && redisUrl && redisToken) {
      try {
        await fetch(`${redisUrl}/set/${encodeURIComponent(cacheKey)}/${encodeURIComponent(answer)}/ex/${cacheTTL}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${redisToken}` }
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
