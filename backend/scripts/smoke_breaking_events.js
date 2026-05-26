#!/usr/bin/env node
/**
 * Smoke test for the breaking-events pipeline.
 *
 *   node scripts/smoke_breaking_events.js          # exercises LLM only with mock threads (fast)
 *   node scripts/smoke_breaking_events.js --live   # pulls real Reddit signals end-to-end
 *
 * Useful for verifying the synth pipeline works after adding API keys
 * without needing to round-trip through the auth-gated HTTP route.
 */

require('dotenv').config();
const { initLlm, isLlmReady, generateJson } = require('../services/llm/client');

const SYSTEM_PROMPT = `You are a real-time event extractor for a live-TV viewer app.

Given a list of Reddit hot threads from breaking-news subreddits, cluster them into 5–12 distinct ACTIVE events that someone might want to watch on live TV right now. Discard:
  - opinion pieces / op-eds / political commentary
  - week-old news / anniversaries / "remember when" posts
  - generic memes or off-topic content
  - duplicate framings of the same event

Respond with strict JSON. No prose, no markdown fences.`;

const SCHEMA = `{
  "events": [
    {
      "title": "short headline-style name",
      "type": "fire|chase|weather|disaster|protest|breaking|sport|politics|other",
      "location": "City, State/Country or null",
      "summary": "one sentence",
      "channel_hints": ["KTLA", "CNN", "ESPN"],
      "confidence": "high|medium|low"
    }
  ]
}`;

const MOCK_THREADS = [
  { sub: 'news',         title: 'Brush fire grows to 800 acres near Malibu, evacuations ordered',                score: 4200, numComments: 612,  ageHours: 3 },
  { sub: 'policechase',  title: 'LIVE: Police pursuit on 405 freeway in LA',                                     score: 1100, numComments: 380,  ageHours: 1 },
  { sub: 'nba',          title: 'Mavericks vs Celtics Game 7 — overtime',                                        score: 9800, numComments: 2400, ageHours: 0 },
  { sub: 'weather',      title: 'Hurricane Lila makes landfall in southern Texas, Cat 3',                        score: 5400, numComments: 700,  ageHours: 4 },
  { sub: 'worldnews',    title: 'Major earthquake (7.2) strikes off Japan coast, tsunami warnings issued',       score: 8200, numComments: 1500, ageHours: 2 },
  { sub: 'wildfires',    title: 'Eaton Fire 0% contained — 5,000 structures threatened',                         score: 3000, numComments: 420,  ageHours: 6 },
  { sub: 'PublicFreakout', title: 'LIVE: Massive protest at city hall downtown Portland',                        score: 2100, numComments: 540,  ageHours: 2 },
  { sub: 'nfl',          title: 'Chiefs vs Eagles SNF — kickoff in 30 min',                                      score: 1500, numComments: 260,  ageHours: 0 }
];

function buildUserPrompt(threads) {
  const lines = threads.map((t, i) =>
    `${i + 1}. r/${t.sub} (score=${t.score}, ${t.numComments} comments, ${t.ageHours}h old): ${t.title}`
  ).join('\n');
  return `Here are the current hot threads (sorted by heat):\n\n${lines}\n\nReturn JSON with the clustered events.`;
}

async function runMock() {
  console.log('--- MOCK MODE — synthesizing 8 fake hot threads ---');
  console.log('LLM ready:', isLlmReady());

  const t0 = Date.now();
  const result = await generateJson({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(MOCK_THREADS),
    schema: SCHEMA,
    maxTokens: 1400,
    temperature: 0.3,
    timeoutMs: 45_000
  });
  console.log(`elapsed: ${Date.now() - t0}ms`);

  if (!result) {
    console.log('NULL — all providers failed');
    return;
  }
  console.log(`events: ${result.events?.length}`);
  console.log('---');
  for (const e of result.events || []) {
    console.log(`• ${(e.type || '?').toUpperCase()} | ${e.title}`);
    console.log(`  loc: ${e.location} | conf: ${e.confidence}`);
    console.log(`  hints: ${(e.channel_hints || []).join(', ')}`);
    console.log(`  summary: ${e.summary}`);
    console.log('');
  }
}

async function runLive() {
  console.log('--- LIVE MODE — pulling real Reddit hot threads ---');
  const { synthesizeEvents } = require('../services/breakingEvents');
  const t0 = Date.now();
  const r = await synthesizeEvents({ force: true });
  console.log(`source: ${r.source}  elapsed: ${Date.now() - t0}ms`);
  console.log(`events: ${r.events.length}`);
  console.log('---');
  for (const e of r.events.slice(0, 8)) {
    console.log(`• ${e.type.toUpperCase()} | ${e.title}`);
    console.log(`  loc: ${e.location} | conf: ${e.confidence}`);
    console.log(`  hints: ${(e.channel_hints || []).join(', ')}`);
    console.log(`  summary: ${e.summary}`);
    console.log('');
  }
}

(async () => {
  initLlm();
  const live = process.argv.includes('--live');
  if (live) await runLive();
  else      await runMock();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
