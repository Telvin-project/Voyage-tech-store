module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      success: false,
      message: 'Use POST to verify a transaction.'
    });
  }

  const secretKey = process.env.KLUMP_SECRET_KEY;

  if (!secretKey) {
    return res.status(500).json({
      success: false,
      message: 'Klump secret key is not configured in Vercel.'
    });
  }

  const reference = String(
    req.body?.reference || ''
  ).trim();

  if (
    !reference ||
    reference.length > 200 ||
    !/^[a-zA-Z0-9_-]+$/.test(reference)
  ) {
    return res.status(400).json({
      success: false,
      message: 'A valid transaction reference is required.'
    });
  }

  try {
    const response = await fetch(
      'https://api.useklump.com/v1/transactions/' +
        encodeURIComponent(reference) +
        '/verify',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'klump-secret-key': secretKey
        }
      }
    );

    const result = await response.json();

    return res.status(response.status).json({
      success: response.ok,
      verification: result
    });
  } catch (error) {
    console.error('Klump verification failed:', error.message);

    return res.status(502).json({
      success: false,
      message: 'Could not reach Klump. Please try again.'
    });
  }
};
