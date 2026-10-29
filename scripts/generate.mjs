// Builds digest.json from today's Wikipedia feed, rewritten by Claude.
import { writeFile } from 'node:fs/promises';

const MODEL = 'claude-haiku-5-5';
const WORDS_PER_CARD = 1000;   // about 5 minutes of reading
const SOURCE_WORDS = 3000;     // how much Wikipedia text to send to Claude
const API_KEY = process.env.ANTHROPIC_API_KEY;
const WIKI_HEADERS = {
    'User-Agent': 'CuriositySpark/1.0 (https://github.com/your-username/curiosity-spark)'
};

if (!API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY. Add it under Settings → Secrets and variables → Actions.');
    process.exit(1);
}

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

// ---------- Claude ----------
async function askClaude(title, context, source) {
    const system =
        'You write "The Curiosity Spark", a daily digest that turns Wikipedia articles into ' +
        'engaging 5-minute reads for curious adults. Use ONLY facts stated in the provided source text. ' +
        'Do not add facts from memory. Respond with a single JSON object and nothing else.';

    const prompt = `Article title: ${title}
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

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 4000,
            system,
            messages: [{ role: 'user', content: prompt }]
        })
    });

    if (!res.ok) {
        throw new Error(`Claude API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const card = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

    if (!card.title || !card.hook || !Array.isArray(card.body) || !card.body.length) {
        throw new Error('Claude returned an incomplete digest');
    }

    if (card.quiz && Array.isArray(card.quiz.options) &&
        card.quiz.options.filter(o => o.correct === true).length === 1) {
        shuffle(card.quiz.options);
    } else {
        card.quiz = null;
    }
    return card;
}

// ---------- Build ----------
async function makeCard(kind, title, context) {
    const source = await fetchArticleText(title, SOURCE_WORDS);

    let ai;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            ai = await askClaude(title, context, source);
            break;
        } catch (err) {
            console.warn(`Attempt ${attempt} for "${title}" failed: ${err.message}`);
            if (attempt === 2) throw err;
        }
    }

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

    const jobs = {};
    if (events.length) {
        const ev = events[seed % events.length];
        jobs.history = makeCard('history', ev.pages[0].title,
            `This article is linked to an "On this day" event from ${ev.year}: ${ev.text}`);
    }
    if (feed.tfa) {
        jobs.featured = makeCard('featured', feed.tfa.title,
            "This is today's featured article on Wikipedia.");
    }

    const keys = Object.keys(jobs);
    const results = await Promise.allSettled(Object.values(jobs));
    const digest = { date: dateStr };

    results.forEach((r, i) => {
        if (r.status === 'fulfilled') digest[keys[i]] = r.value;
        else console.error(`${keys[i]} card failed: ${r.reason?.message}`);
    });

    if (!digest.history && !digest.featured) {
        throw new Error('No cards could be generated today.');
    }

    await writeFile('digest.json', JSON.stringify(digest, null, 2));
    console.log(`Wrote digest.json for ${dateStr} with: ${Object.keys(digest).filter(k => k !== 'date').join(', ')}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
