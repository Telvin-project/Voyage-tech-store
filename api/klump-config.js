
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      success: false,
      message: 'Method not allowed'
    });
  }

  const publicKey = process.env.KLUMP_PUBLIC_KEY;

  if (!publicKey) {
    return res.status(500).json({
      success: false,
      message: 'Klump public key is not configured in Vercel.'
    });
  }

  return res.status(200).json({
    success: true,
    publicKey
  });
};
