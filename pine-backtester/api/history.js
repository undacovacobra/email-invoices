// Cloud version of the local server's /api/history (Vercel serverless function).
import { history, validRequest } from '../src/market.js';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || 'MNQ1!');
  const interval = String(req.query.interval || '1m');
  if (!validRequest(symbol, interval)) {
    res.status(400).json({ error: 'unknown symbol or interval' });
    return;
  }
  try {
    const data = await history(symbol, interval);
    // let the CDN reuse a download for a minute, so many visits don't all hit Yahoo
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
