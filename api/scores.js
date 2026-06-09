async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { type } = req.query; // 'fixtures' or 'standings'

  try {
    if (type === 'standings') {
      const response = await fetchWithRetry(
        'https://api.football-data.org/v4/competitions/WC/standings',
        { headers: { 'X-Auth-Token': apiKey } }
      );
      const data = await response.json();
      return res.status(200).json(data);
    } else {
      const response = await fetchWithRetry(
        'https://api.football-data.org/v4/competitions/WC/matches?status=SCHEDULED,LIVE,IN_PLAY,PAUSED,FINISHED',
        { headers: { 'X-Auth-Token': apiKey } }
      );
      const data = await response.json();
      return res.status(200).json(data);
    }
  } catch (err) {
    console.error('Scores API error:', err);
    return res.status(500).json({ error: 'Failed to fetch scores' });
  }
}
