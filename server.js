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

app.get('/', (req, res) => {
  res.json({ status: 'JMR Claude Proxy running' });
});

// Streaming proxy — buffers the full Anthropic streaming response,
// sends incremental SSE-style chunks so Railway's proxy doesn't time out,
// then emits the complete JSON response at the end.
app.post('/api/claude-proxy', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Force streaming on the Anthropic request
  const body = { ...req.body, stream: true };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(580000),
    });

    if (!response.ok) {
      const errData = await response.json();
      return res.status(response.status).json(errData);
    }

    // Read the SSE stream, accumulate content, keep connection alive
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = null;
    let model = req.body.model || 'unknown';
    let lastFlush = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            fullText += event.delta.text;
          }
          if (event.type === 'message_delta') {
            stopReason = event.delta?.stop_reason || stopReason;
            outputTokens = event.usage?.output_tokens || outputTokens;
          }
          if (event.type === 'message_start') {
            inputTokens = event.message?.usage?.input_tokens || 0;
            model = event.message?.model || model;
          }
        } catch (e) {
          // skip malformed events
        }
      }

      // Send a whitespace keepalive byte every 5 seconds to prevent Railway proxy timeout
      const now = Date.now();
      if (now - lastFlush > 5000) {
        res.write(' ');
        lastFlush = now;
      }
    }

    // Emit the complete response in standard Anthropic messages format
    const finalResponse = {
      id: 'msg_streamed',
      type: 'message',
      role: 'assistant',
      model: model,
      content: [{ type: 'text', text: fullText }],
      stop_reason: stopReason || 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };

    res.end(JSON.stringify(finalResponse));

  } catch (err) {
    console.error('Proxy error:', err.name, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy error: ' + err.message });
    } else {
      res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
    }
  }
});

const server = app.listen(PORT, () => {
  console.log(`JMR Claude Proxy (streaming) listening on port ${PORT}`);
});

server.timeout = 0;
server.keepAliveTimeout = 620000;
server.headersTimeout = 630000;