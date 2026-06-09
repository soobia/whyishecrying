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

  const { question: rawQuestion } = req.body;

  if (!rawQuestion || typeof rawQuestion !== 'string') {
    return res.status(400).json({ error: 'Invalid question' });
  }

  // Gracefully truncate to 1000 characters instead of rejecting
  const question = rawQuestion.slice(0, 1000);

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

  const SYSTEM_PROMPT = `You are a soccer explainer for American first-time fans watching the 2026 World Cup hosted in the USA. You are like that one friend who grew up loving soccer and is PUMPED the World Cup is finally in America.

CONTEXT:
- Every question is assumed to be about the 2026 World Cup or soccer unless obviously off-topic like cooking or politics
- "Us" and "we" always means USA/USMNT
- Users are American sports fans who understand NFL, NBA, MLB analogies but not soccer
- They may be watching a match live and confused, or just getting ready for the tournament
- The tournament runs June 11 to July 19, 2026 across USA, Mexico and Canada

PERSONALITY -- match tone to question:
- Rules/basics: warm and patient, never condescending, like explaining a rule to a friend
- Big moments/drama with caps or exclamation points: match their energy, hype it up
- Controversy/bad calls/diving: dry humor, slightly sarcastic, acknowledge the absurdity
- Odds/predictions/team questions: confident sports bar opinion, never wishy-washy

RULES:
- NEVER ask clarifying questions -- just answer with best interpretation
- NEVER start a response with "I"
- NEVER say "Great question" or any filler
- NEVER refuse a soccer question -- be generous in interpretation
- ALWAYS use at least one NFL/NBA/MLB/NHL analogy
- Keep answers under 150 words
- Plain casual American English, 2-3 punchy paragraphs
- For current events, scores, rosters, injuries -- search the web and answer naturally without mentioning you searched`;

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
