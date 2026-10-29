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
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: 16384,
                temperature: 0.8
            }
        })
    });

    if (!res.ok) {
        const err = new Error(`Gemini (${model}) error ${res.status}: ${(await res.text()).slice(0, 300)}`);
        err.status = res.status;
        throw err;
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
        throw new Error(`Gemini (${model}) reply was cut off before it finished`);
    }

    const parts = candidate?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('');
    if (!text) {
        throw new Error(`Gemini (${model}) returned no text (finish reason: ${candidate?.finishReason || 'unknown'})`);
    }
    return text;
}

async function askAI(title, context, source) {
    const prompt = buildPrompt(title, context, source);
    let lastError;

    for (const model of MODELS) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const text = await callGemini(model, prompt);
                const card = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

                if (!card.title || !card.hook || !Array.isArray(card.body) || !card.body.length) {
                    throw new Error('AI returned an incomplete digest');
                }

                if (card.quiz && Array.isArray(card.quiz.options) &&
                    card.quiz.options.filter(o => o.correct === true).length === 1) {
                    shuffle(card.quiz.options);
                } else {
                    card.quiz = null;
                }

                console.log(`"${title}" written by ${model}`);
                return card;
            } catch (err) {
                lastError = err;
                console.warn(`Attempt ${attempt} with ${model} failed: ${err.message}`);
                if (err.status === 404 || err.status === 400) break;   // model unavailable; try the next one
                if (err.status === 401 || err.status === 403) throw err; // bad key; no point retrying
                await sleep(err.status === 429 ? 65000 : 10000);        // wait out rate limits
            }
        }
    }
    throw lastError;
}

// ---------- Build ----------
async function makeCard(kind, title, context) {
    const source = await fetchArticleText(title, SOURCE_WORDS);
    const ai = await askAI(title, context, source);
    return {
        ...ai,
        type: kind === 'history' ? 'history' : 'science',
        label: kind === 'history' ? 'On This Day' : "Today's Featured Article",
        link: `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`
    };
}

async function main() {
    const today = new Date();
    const dateStr = isoDate(today);

    let feed;
    try {
        feed = await fetchFeed(dateStr);
    } catch {
        const yesterday = new Date(today);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        feed = await fetchFeed(isoDate(yesterday));
    }

    const seed = Math.floor(Date.parse(dateStr) / 86400000);
    const events = (feed.onthisday || []).filter(e => e.pages && e.pages.length);

    const tasks = [];
    if (events.length) {
        const ev = events[seed % events.length];
        tasks.push(['history', ev.pages[0].title,
            `This article is linked to an "On this day" event from ${ev.year}: ${ev.text}`]);
    }
    if (feed.tfa) {
        tasks.push(['featured', feed.tfa.title, "This is today's featured article on Wikipedia."]);
    } else {
        console.warn("Wikipedia's feed had no featured article today.");
    }

    // One card at a time, with a pause in between, to stay within free-tier rate limits
    const digest = { date: dateStr };
    let firstError;
    for (const [i, [kind, title, context]] of tasks.entries()) {
        if (i > 0) {
            console.log(`Pausing ${PAUSE_BETWEEN_CARDS / 1000}s before the next card...`);
            await sleep(PAUSE_BETWEEN_CARDS);
        }
        try {
            digest[kind] = await makeCard(kind, title, context);
        } catch (err) {
            firstError = firstError || err;
            console.error(`${kind} card failed: ${err.message}`);
        }
    }

    if (!digest.history && !digest.featured) {
        throw firstError || new Error('Wikipedia had no entries today.');
    }

    await writeFile('digest.json', JSON.stringify(digest, null, 2));
    console.log(`Wrote digest.json for ${dateStr} with: ${Object.keys(digest).filter(k => k !== 'date').join(', ')}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
