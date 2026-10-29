// Builds digest.json from today's Wikipedia feed, rewritten by Google Gemini.
import { writeFile } from 'node:fs/promises';

// Tried in order; if Google retires one, the next is used.
const MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'];
const WORDS_PER_CARD = 1000;      // about 5 minutes of reading
const SOURCE_WORDS = 3000;        // how much Wikipedia text to send
const PAUSE_BETWEEN_CARDS = 65000; // 65 seconds, to respect free-tier rate limits
const API_KEY = process.env.GEMINI_API_KEY;
const WIKI_HEADERS = {
    'User-Agent': 'CuriositySpark/1.0 (https://github.com/your-username/curiosity-spark)'
};

if (!API_KEY) {
    console.error('Missing GEMINI_API_KEY. Add it under Settings → Secrets and variables → Actions.');
    process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function isoDate(d) {
    return d.toISOString().slice(0, 10); // UTC, e.g. 2026-10-29
}

// ---------- Wikipedia ----------
async function fetchFeed(dateStr) {
    const [y, m, d] = dateStr.split('-');
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`, { headers: WIKI_HEADERS });
    if (!res.ok) throw new Error(`Wikipedia feed returned ${res.status}`);
    return res.json();
}

async function fetchArticleText(title, maxWords) {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts' +
        '&explaintext=1&exsectionformat=plain&redirects=1&format=json' +
        `&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    if (!res.ok) throw new Error(`Wikipedia article returned ${res.status}`);
    const json = await res.json();
    const text = Object.values(json.query.pages)[0].extract || '';
    const cutoff = text.search(/\n(See also|References|Notes|Citations|External links|Further reading)\s*\n/);
    const body = cutoff > 0 ? text.slice(0, cutoff) : text;
    return body.split(/\s+/).slice(0, maxWords).join(' ');
}

// ---------- Gemini ----------
const SYSTEM_PROMPT =
    'You write "The Curiosity Spark", a daily digest that turns Wikipedia articles into ' +
    'engaging 5-minute reads for curious adults. Use ONLY facts stated in the provided source text. ' +
    'Do not add facts from memory. Respond with a single JSON object and nothing else.';

function buildPrompt(title, context, source) {
    return `Article title: ${title}
Context: ${context}

<source>
${source}
</source>

Write a digest of this article as JSON with exactly this shape:
{
  "title": "a catchy title, under 10 words",
  "hook": "2-3 vivid sentences that make the reader want to keep going",
  "body": ["5 to 8 paragraphs totalling about ${WORDS_PER_CARD} words, telling the story in a lively, clear way"],
  "takeaway": "one memorable sentence someone could share at dinner",
  "quiz": {
    "question": "a question answerable from the body text",
    "options": [{"text": "...", "correct": true}, {"text": "...", "correct": false}, {"text": "...", "correct": false}],
    "explanation": "one sentence explaining the answer"
  }
}
Exactly one quiz option must be correct.`;
}

async function callGemini(model, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'x-goog-api-key': API_KEY,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text:
