const express = require('express');
const app = express();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'https://xml-convert.pixeler.com',
  'http://xml-convert.pixeler.com',
  'http://localhost',
  'http://127.0.0.1',
];

app.use(express.json({ limit: '10mb' }));

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'JMR Claude Proxy running' });
});

// Proxy endpoint — streams response back to keep connection alive
app.post('/api/claude-proxy', async (req, res) => {
  req.setTimeout(0);   // disable request timeout
  res.setTimeout(0);   // disable response timeout

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    // Use streaming to keep the connection alive during long generations
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(580000), // 9.5 minute hard limit
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (err) {
    console.error('Proxy error:', err.name, err.message);
    return res.status(502).json({ error: 'Proxy error: ' + err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`JMR Claude Proxy listening on port ${PORT}`);
});

// Completely disable all server-level timeouts
server.timeout = 0;
server.keepAliveTimeout = 620000;  // 10+ minutes
server.headersTimeout = 630000;
server.requestTimeout = 0;