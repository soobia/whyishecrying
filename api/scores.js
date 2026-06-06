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
      const response = await fetch(
        'https://api.football-data.org/v4/competitions/WC/standings',
        { headers: { 'X-Auth-Token': apiKey } }
      );
      if (!response.ok) throw new Error('API error');
      const data = await response.json();
      return res.status(200).json(data);
    } else {
      // Fixtures -- get matches
      const response = await fetch(
        'https://api.football-data.org/v4/competitions/WC/matches?status=SCHEDULED,LIVE,IN_PLAY,PAUSED,FINISHED',
        { headers: { 'X-Auth-Token': apiKey } }
      );
      if (!response.ok) throw new Error('API error');
      const data = await response.json();
      return res.status(200).json(data);
    }
  } catch (err) {
    console.error('Scores API error:', err);
    return res.status(500).json({ error: 'Failed to fetch scores' });
  }
}
