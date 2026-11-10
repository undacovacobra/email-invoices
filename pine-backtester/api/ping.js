// Lets the app know the market-data endpoint is available.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
}
