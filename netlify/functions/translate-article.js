// Netlify serverless function: natural, meaning-based (bhabanubad / sense-for-
// sense) Bangla translation of an article -- NOT a literal word-for-word
// translation. Uses Google's Gemini API (same free-tier key as the deep
// grammar breakdown feature).

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_CHARS = 8000;

const SYSTEM_PROMPT = `You are an expert English-to-Bangla literary translator.

Translate the given English text into natural, fluent, idiomatic Bangla -- a "ভাবানুবাদ" (sense-for-sense / meaning-based translation), NOT a literal word-for-word translation.

Rules:
1. Preserve the original meaning, tone, and paragraph breaks.
2. Write the way an educated native Bangla speaker would naturally express the same ideas -- prioritize how it reads in Bangla over mirroring English sentence structure or word order.
3. Freely restructure sentences, combine or split them, and reorder clauses as needed so the Bangla reads smoothly and naturally.
4. Do not add explanations, notes, or commentary. Output ONLY the Bangla translation, nothing else -- no markdown, no English.`;

function jsonResponse(statusCode, body) {
  if (statusCode >= 400) {
    console.error('[function error]', statusCode, JSON.stringify(body).slice(0, 1000));
  }
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, {
      error: 'server_not_configured',
      message: 'GEMINI_API_KEY is not set. Add it in Netlify: Site settings -> Environment variables, then redeploy.'
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return jsonResponse(400, { error: 'No text provided' });
  }
  if (text.length > MAX_CHARS) {
    return jsonResponse(400, { error: `Text too long (max ${MAX_CHARS} characters)` });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: {
          responseMimeType: 'text/plain',
          maxOutputTokens: 4096,
          temperature: 0.4
        }
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const isQuota = resp.status === 429;
      return jsonResponse(502, {
        error: isQuota ? 'ai_quota_exceeded' : 'ai_service_error',
        status: resp.status,
        detail: errText.slice(0, 500)
      });
    }

    const data = await resp.json();
    const candidate = (data.candidates || [])[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const translation = Array.isArray(parts) && parts[0] ? (parts[0].text || '').trim() : '';

    if (!translation) {
      return jsonResponse(502, {
        error: 'ai_empty_response',
        finishReason: candidate ? candidate.finishReason : null
      });
    }

    return jsonResponse(200, { translation });
  } catch (e) {
    return jsonResponse(500, { error: 'request_failed', detail: String(e).slice(0, 300) });
  }
};
