// Netlify serverless function: deep grammar breakdown for the Article Reader.
//
// Uses Google's Gemini API (free tier) instead of a paid provider, so this
// feature can run at $0 cost. Get a free key at https://aistudio.google.com
// (Google AI Studio -> "Get API key") -- no credit card required as long as
// you stay on the free usage tier. Set it in Netlify: Site settings ->
// Environment variables -> GEMINI_API_KEY. The key never reaches the browser.
//
// Heads up: on Gemini's free tier, Google may use the prompts/responses sent
// through this function to improve their products (this is not the case on
// their paid tier). Don't paste anything private/sensitive into the article
// box if that matters to you.
//
// The client sends a small batch of plain-text sentences; this function asks
// Gemini to break each one into clauses and phrases (noun/verb/adjective/
// adverb/prepositional), explain what modifies what and why articles and
// prepositions were chosen (or omitted), and give a Bangla meaning -- all as
// strict JSON that the front-end renders directly.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const MAX_SENTENCES_PER_REQUEST = 6;

const SYSTEM_PROMPT = `You are an expert English grammar teacher preparing material for a Bengali-speaking English learner using a reading app called Lexora.

For EACH sentence you are given, produce a grammatical breakdown following EXACTLY this JSON schema (no extra keys, no missing keys, no commentary outside the JSON):

{
  "sentences": [
    {
      "sentence": "<the exact original sentence, unchanged, including its ending punctuation>",
      "meaning_bn": "<a natural, fluent Bangla translation of the whole sentence>",
      "clauses": [
        {
          "type": "main | subordinate | relative | noun-clause | infinitive | gerund | participle",
          "label_bn": "<short Bangla label for this clause, e.g. 'প্রধান ক্লজ', 'কারণবাচক অধীন ক্লজ (because-clause)', 'সম্বন্ধবাচক ক্লজ (relative clause)'>",
          "text": "<exact substring of the sentence that forms this clause, copied character-for-character>",
          "phrases": [
            {
              "text": "<exact substring of the clause's text for this phrase, copied character-for-character>",
              "type": "NP | VP | AdjP | AdvP | PP | Conj | Other",
              "role_bn": "<short Bangla label of its grammatical role, e.g. 'কর্তা (subject)', 'কর্ম (object)', 'পূরক (complement)', 'ক্রিয়া-বিশেষণ (adverbial)'>",
              "note_bn": "<1-2 sentence Bangla explanation of what this phrase modifies, what it follows, and why it sits in that position>"
            }
          ]
        }
      ],
      "articles": [
        {
          "word": "the | a | an | (none)",
          "context": "<the noun phrase this article belongs to, or where an article is notably absent>",
          "reason_bn": "<Bangla explanation of why this article was used, or why none was used (e.g. plural/uncountable noun, generic reference, previously-mentioned/specific noun, etc.)>"
        }
      ],
      "prepositions": [
        {
          "word": "<the preposition>",
          "after": "<the exact word or phrase immediately before it that it attaches to>",
          "reason_bn": "<Bangla explanation of why this preposition is used after that word -- verb-preposition collocation, meaning, etc.>"
        }
      ]
    }
  ]
}

CRITICAL RULES -- follow all of them exactly:
1. Inside each clause, all "phrases[].text" values, concatenated in order (joined by a single space where needed), must reconstruct that clause's "text" EXACTLY -- every word, in order, no gaps, no additions.
2. All clauses' "text" values, concatenated in order (joined by a single space where needed), must reconstruct the full original "sentence" EXACTLY, including its ending punctuation.
3. Find EVERY subordinate, relative, noun, infinitive, gerund, or participle clause present -- not just the main clause. A simple sentence may have only one "main" clause; that is fine.
4. List EVERY preposition in the sentence, and EVERY article that is used AND any place where an article is notably expected but omitted (e.g. before a plural or uncountable noun where a learner might wonder why there's no "the"/"a").
5. Output ONLY the JSON object above. No markdown code fences, no explanation before or after it.
6. Every "label_bn", "role_bn", "note_bn", "reason_bn", and "meaning_bn" value must be written in natural, clear Bangla.`;

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
      message: 'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com, then add it in Netlify: Site settings -> Environment variables, and redeploy.'
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const sentences = Array.isArray(payload.sentences)
    ? payload.sentences.filter((s) => typeof s === 'string' && s.trim().length > 0)
    : [];

  if (!sentences.length) {
    return jsonResponse(400, { error: 'No sentences provided' });
  }
  if (sentences.length > MAX_SENTENCES_PER_REQUEST) {
    return jsonResponse(400, { error: `Too many sentences in one request (max ${MAX_SENTENCES_PER_REQUEST})` });
  }

  const userPrompt =
    'Sentences (JSON array, analyze each one independently):\n' +
    JSON.stringify(sentences) +
    '\n\nReturn ONLY the JSON object described in your instructions.';

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
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 8192,
          temperature: 0.2
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
    let raw = Array.isArray(parts) && parts[0] ? (parts[0].text || '') : '';
    raw = raw.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '');

    if (!raw) {
      return jsonResponse(502, {
        error: 'ai_empty_response',
        finishReason: candidate ? candidate.finishReason : null
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return jsonResponse(502, {
        error: 'ai_invalid_json',
        raw: raw.slice(0, 800)
      });
    }

    return jsonResponse(200, parsed);
  } catch (e) {
    return jsonResponse(500, { error: 'request_failed', detail: String(e).slice(0, 300) });
  }
};
