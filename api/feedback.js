import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Allowed origins ───────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://meettheowl.com',
  'https://www.meettheowl.com',
  'http://localhost:5173',
];

// ── Exercise context (cached in the system prompt) ────────────────────────
// One entry per exercise. Add future exercises here.
const EXERCISE_CONTEXT = {
  'html-text-tags': {
    expected: '<h1>, <h2>, <h3>, <p>, <p>',
  },
};

// ── In-memory rate limiter ────────────────────────────────────────────────
// Best-effort — resets on cold start. For persistent limits, swap for Vercel KV.
const requestLog = new Map();
const RATE_LIMIT = 10;       // requests per window
const RATE_WINDOW = 60_000;  // 1 minute in ms

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestLog.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    requestLog.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  requestLog.set(ip, entry);
  return false;
}

// ── Structure formatter ───────────────────────────────────────────────────
// Turns the normalised node tree into readable lines for Claude.
// Text content was stripped in the browser — Claude only ever sees tags.
function formatStructure(nodes, depth = 0) {
  return nodes.map(n => {
    const indent = '  '.repeat(depth);
    const attrs = n.attrs.length ? ` [${n.attrs.join(', ')}]` : '';
    const children = n.children.length
      ? '\n' + formatStructure(n.children, depth + 1)
      : '';
    return `${indent}<${n.tag}>${attrs}${children}`;
  }).join('\n');
}

// ── Apps Script logger ────────────────────────────────────────────────────
// Fire-and-forget — never blocks the feedback response.
// Set APPS_SCRIPT_URL in Vercel env when ready; it's optional.
function logToAppsScript(payload) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) return;
  const secret = process.env.LOG_SECRET;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Log-Secret': secret } : {}),
    },
    body: JSON.stringify(payload),
  }).catch(() => {}); // never propagate — logging must never break feedback
}

// ── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const origin = req.headers.origin || '';

  // CORS
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Origin guard
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Rate limit
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { exerciseId, structure } = body || {};

  if (!exerciseId || !EXERCISE_CONTEXT[exerciseId]) {
    return res.status(400).json({ error: 'Unknown exercise' });
  }
  if (!Array.isArray(structure) || structure.length === 0) {
    return res.status(400).json({ error: 'Invalid structure' });
  }

  // Size cap — reject before spending tokens
  const structureStr = JSON.stringify(structure);
  if (structureStr.length > 2000) {
    return res.status(400).json({ error: 'Submission too large' });
  }

  // ── Claude call ─────────────────────────────────────────────────────────
  try {
    const ctx = EXERCISE_CONTEXT[exerciseId];
    const formattedStructure = formatStructure(structure);

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      system: [
        {
          type: 'text',
          // This block is constant per exercise — eligible for prompt caching.
          // The cache_control marker tells Claude to cache up to this point.
          text: `You give short, direct feedback to someone learning HTML for the first time.

They are working on an exercise that asks them to write: ${ctx.expected}.
Their code has been normalised — all text content is stripped. You only see tag names and attribute names, never values or text.
The submission is structurally divergent from the exercise in a way the rules did not pre-script.

Write 1–2 sentences of plain text feedback. Be specific about what is structurally unexpected.
If they used valid but unexpected HTML (like semantic tags), name it and redirect to the exercise.
Do not use markdown, HTML tags, or bullet points in your response.
Do not say "great try", "well done", "don't worry", or "just".
Do not explain what HTML is. Do not end by summarising what they should do.`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Submitted structure:\n${formattedStructure}`,
        },
      ],
    });

    const feedback = message.content[0]?.text?.trim() || 'Could not generate feedback.';

    // Log async — never await, never block
    logToAppsScript({
      exerciseId,
      type: 'DIVERGENT',
      structureHash: Buffer.from(structureStr).toString('base64').slice(0, 16),
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
      cachedTokens: message.usage?.cache_read_input_tokens ?? 0,
      timestamp: new Date().toISOString(),
    });

    // Return plain text — browser renders with textContent, never innerHTML
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(feedback);

  } catch (err) {
    console.error('Claude API error:', err?.message ?? err);
    return res.status(500).json({ error: 'Feedback unavailable' });
  }
}
