/**
 * Sports-event → channel matcher, v2.
 *
 * Inspired by PiratesIRC/Dispatcharr-EPG-Janitor's fuzzy_matcher.py —
 * the only OSS reference implementation that actually handles this
 * problem well. The shape is:
 *
 *   1. Scrub channel text (strip [HD]/[4K]/(Backup)/country prefixes etc.)
 *   2. Build candidate aliases per team from the team_aliases registry
 *   3. Score the scrubbed text against each alias through a stage cascade:
 *        a. exact whole-phrase match        → 150 (per team)
 *        b. whole-word containment          → 100 (per team)
 *        c. token-set/token-sort fuzzy hit  → up to 70 (per team)
 *      First hit per-team wins; we don't double-count.
 *   4. Layer bonuses:
 *        both teams scored              → +200
 *        same-league keyword in text    → +50
 *        different-sport keyword in text → −120
 *   5. Optional EPG program-title pass: score the channel's current
 *      program title through the same stage cascade. If both teams hit
 *      in the program title, add +300 — that's gold-tier evidence the
 *      channel is airing the game right now, even if the channel name
 *      is generic ("MLS 05", "ESPN 2").
 *
 * The old `calculateRelevanceScore` in channelScoring.js is still used
 * by callers that haven't been migrated and as a fallback when no
 * team_aliases row exists. That path is intentionally not removed in
 * this pass — migration is a per-route decision.
 */

const FuzzySet = require('fuzzyset');

// Strip everything we've seen IPTV providers paste into channel names
// that isn't part of the actual channel identity. Runs on a lowercased
// copy, returns a normalised lowercased string.
const SCRUB_PATTERNS = [
  /\[(hd|fhd|uhd|4k|sd|720p|1080p|4k[a-z]*|backup|alt[a-z]*)\]/g,
  /\((hd|fhd|uhd|4k|sd|720p|1080p|backup|alt[a-z]*|east|west|central|pacific)\)/g,
  /\b(hd|fhd|uhd|4k|sd|720p|1080p)\b/g,
  /\b(east coast|west coast|pacific|central)\b/g,
  /^(us|usa|ca|uk|gb|es|mx|de|fr|it)\s*[:|-]\s*/,  // country prefix
  /\|\s*(us|usa|ca|uk|gb)\s*\|/g,
  /\s*\|\s*/g,                                        // pipes → spaces
  /[\u{1D400}-\u{1D7FF}]/gu,                          // mathematical alphanumeric unicode
  /\b(ᴿᴬᵂ|ᴴᴰ|ᶠᴴᴰ)\b/gu,
  /\s+/g                                              // collapse whitespace last
];

function scrub(text) {
  if (!text) return '';
  let s = String(text).toLowerCase();
  for (const pat of SCRUB_PATTERNS) {
    s = s.replace(pat, ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Word-boundary containment. Escapes regex meta so aliases with dots
// ("D.C. United", "St. Louis") work. `\b` handles punctuation/whitespace
// edges, not mid-word hits.
function wordContains(haystack, needle) {
  if (!needle) return false;
  const escaped = String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
  } catch {
    return haystack.toLowerCase().includes(String(needle).toLowerCase());
  }
}

// Keyword sets for league context. Same idea as channelScoring.js but
// kept local so the two matchers can evolve independently.
const LEAGUE_KEYWORDS = {
  mls: ['mls'],
  nhl: ['nhl'],
  ahl: ['ahl'],
  nba: ['nba'],
  wnba: ['wnba'],
  nfl: ['nfl'],
  mlb: ['mlb'],
  ncaa: ['ncaa', 'college'],
  cfb: ['cfb'],
  cbb: ['cbb'],
  epl: ['epl', 'premier league'],
  laliga: ['la liga', 'laliga'],
  seriea: ['serie a'],
  bundesliga: ['bundesliga'],
  ucl: ['champions league', 'ucl'],
  uel: ['europa league', 'uel'],
  qmjhl: ['qmjhl']
};

const LEAGUE_SPORT = {
  mls: 'soccer', epl: 'soccer', laliga: 'soccer', seriea: 'soccer',
  bundesliga: 'soccer', ucl: 'soccer', uel: 'soccer',
  nhl: 'hockey', ahl: 'hockey', qmjhl: 'hockey',
  nba: 'basketball', wnba: 'basketball', cbb: 'basketball',
  nfl: 'football', cfb: 'football',
  mlb: 'baseball'
};

function normalizeLeague(leagueName) {
  if (!leagueName) return null;
  const lower = String(leagueName).toLowerCase();
  if (/\bmls\b|major league soccer/.test(lower)) return 'mls';
  if (/\bahl\b/.test(lower)) return 'ahl';
  if (/\bnhl\b/.test(lower)) return 'nhl';
  if (/\bwnba\b/.test(lower)) return 'wnba';
  if (/\bnba\b/.test(lower)) return 'nba';
  if (/\bnfl\b/.test(lower)) return 'nfl';
  if (/\bmlb\b/.test(lower)) return 'mlb';
  if (/\bepl\b|premier league/.test(lower)) return 'epl';
  if (/la liga|laliga/.test(lower)) return 'laliga';
  if (/serie a/.test(lower)) return 'seriea';
  if (/bundesliga/.test(lower)) return 'bundesliga';
  if (/champions league|\bucl\b/.test(lower)) return 'ucl';
  if (/europa league|\buel\b/.test(lower)) return 'uel';
  if (/ncaa.*football|\bcfb\b|college football/.test(lower)) return 'cfb';
  if (/ncaa.*basketball|\bcbb\b|college basketball/.test(lower)) return 'cbb';
  if (/\bncaa\b/.test(lower)) return 'ncaa';
  return null;
}

// Score for each alias tier when a hit is found. Only the highest
// tier wins — we don't sum across tiers, so a channel named "Colorado
// Rapids" scores 150 (full) not 150+100+50 (full + mascot + city).
const TIER_SCORE = {
  full:   150,
  mascot: 100,
  abbr:   100,
  manual: 100,
  short:  80,
  city:   50
};

// Order we try tiers when scoring a team against a scrubbed text.
// Higher-confidence tiers first so the first hit wins.
const TIER_ORDER = ['full', 'mascot', 'abbr', 'manual', 'short', 'city'];

/**
 * Stage-cascade score for one team's tiered alias bundle against a
 * scrubbed target text. Takes an object with per-tier alias lists
 * and returns { score, stage, tier, matched }.
 *
 * Accepts either the new tiered shape or a legacy flat array (treated
 * as 'manual' tier) for back-compat with callers that haven't migrated.
 */
function scoreAliases(scrubbed, aliasesOrBundle) {
  if (!scrubbed) return { score: 0, stage: null, tier: null, matched: null };

  // Normalise input: legacy array → synthetic manual bundle.
  const tiered = Array.isArray(aliasesOrBundle)
    ? { full: [], mascot: [], abbr: [], manual: aliasesOrBundle.map(String), short: [], city: [] }
    : (aliasesOrBundle || null);
  if (!tiered) return { score: 0, stage: null, tier: null, matched: null };

  // Try tiers in confidence order.
  for (const tier of TIER_ORDER) {
    const list = tiered[tier] || [];
    if (list.length === 0) continue;
    const tierScore = TIER_SCORE[tier] || 50;

    for (const alias of list) {
      if (!alias) continue;
      const a = String(alias).toLowerCase();

      if (a.length < 2) continue;

      // Multi-word aliases: substring match counts as whole phrase.
      // Single-word aliases must be word-bounded so "LA" doesn't match
      // "class", "york" doesn't match "yorkshire", etc.
      const hit = a.includes(' ')
        ? scrubbed.includes(a)
        : wordContains(scrubbed, a);

      if (hit) return { score: tierScore, stage: 'literal', tier, matched: alias };
    }
  }

  // Fuzzy fallback — only when NO literal hit at any tier. Run against
  // the canonical full and mascot terms (the ones we most want typo
  // tolerance for); city/abbr fuzzy is more noise than signal.
  const fuzzyCandidates = [
    ...(tiered.full || []),
    ...(tiered.mascot || [])
  ].filter(a => a && String(a).length >= 4);
  if (fuzzyCandidates.length > 0) {
    const words = scrubbed.split(/[\s|:@\-\/]+/).filter(w => w.length >= 3);
    if (words.length > 0) {
      const fuzzy = FuzzySet(words);
      let best = 0;
      let bestAlias = null;
      for (const alias of fuzzyCandidates) {
        const hit = fuzzy.get(String(alias).toLowerCase(), null, 0.8);
        if (hit && hit.length > 0) {
          const s = Math.round(hit[0][0] * 70);
          if (s > best) { best = s; bestAlias = alias; }
        }
      }
      if (best > 0) return { score: best, stage: 'fuzzy', tier: 'fuzzy', matched: bestAlias };
    }
  }

  return { score: 0, stage: null, tier: null, matched: null };
}

/**
 * Same-league bonus / different-sport penalty. Same rationale as the
 * equivalent in channelScoring.js — pushed here so the new matcher
 * is self-contained.
 */
function scoreLeagueContext(scrubbed, sportType, leagueName) {
  const targetLeague = normalizeLeague(leagueName);
  const targetSport = (sportType || '').toLowerCase() ||
    (targetLeague ? LEAGUE_SPORT[targetLeague] : null);

  if (!targetLeague && !targetSport) return 0;

  let score = 0;

  if (targetLeague) {
    for (const kw of LEAGUE_KEYWORDS[targetLeague] || []) {
      if (wordContains(scrubbed, kw)) {
        score += 50;
        break;
      }
    }
  }

  for (const [league, keywords] of Object.entries(LEAGUE_KEYWORDS)) {
    if (league === targetLeague) continue;
    const otherSport = LEAGUE_SPORT[league];
    if (!otherSport || otherSport === targetSport) continue;
    for (const kw of keywords) {
      if (wordContains(scrubbed, kw)) {
        score -= 120;
        return score;
      }
    }
  }

  return score;
}

/**
 * Score a block of text (channel name OR EPG program title) against
 * two team alias bundles + context. Pure function — safe to call
 * twice and combine the results.
 *
 * Accepts either the new tiered bundle shape (`{full, mascot, abbr,
 * short, manual, city}`) or a legacy flat array (treated as manual
 * tier) for back-compat with older callers.
 */
function scoreText(text, homeAliases, awayAliases, context = {}) {
  const scrubbed = scrub(text);
  if (!scrubbed) {
    return {
      score: 0,
      homeStage: null, awayStage: null,
      homeTier: null, awayTier: null,
      homeMatch: null, awayMatch: null,
      leagueBonus: 0, bothTeamsBonus: 0
    };
  }

  const home = scoreAliases(scrubbed, homeAliases);
  const away = scoreAliases(scrubbed, awayAliases);

  // Both-teams bonus — but only when BOTH hits are at a meaningful
  // tier. Two city-only hits ("Colorado" + "Los Angeles" in a travel
  // show named "Colorado to Los Angeles") would otherwise score 50+50+200=300
  // and falsely beat real team channels.
  const homeMeaningful = home.tier && home.tier !== 'city';
  const awayMeaningful = away.tier && away.tier !== 'city';
  const bothTeamsBonus = (homeMeaningful && awayMeaningful) ? 200 : 0;

  const leagueBonus = scoreLeagueContext(scrubbed, context.sportType, context.leagueName);

  return {
    score: home.score + away.score + bothTeamsBonus + leagueBonus,
    homeStage: home.stage,
    awayStage: away.stage,
    homeTier: home.tier,
    awayTier: away.tier,
    homeMatch: home.matched,
    awayMatch: away.matched,
    leagueBonus,
    bothTeamsBonus
  };
}

/**
 * Primary matcher entry. Combines channel-name scoring with an
 * optional EPG-program-title scoring pass.
 *
 * @param {object}   channel            — {name, currentProgramTitle?}
 * @param {string[]} homeAliases        — aliases from team_aliases
 * @param {string[]} awayAliases        — aliases from team_aliases
 * @param {object}   context            — {sportType, leagueName}
 * @returns {object} { score, details }
 */
function matchChannel(channel, homeAliases, awayAliases, context = {}) {
  const nameResult = scoreText(channel.name, homeAliases, awayAliases, context);

  let programResult = null;
  let programBonus = 0;
  let epgConfirmed = false;
  let epgMismatch = false;

  if (channel.currentProgramTitle) {
    programResult = scoreText(channel.currentProgramTitle, homeAliases, awayAliases, context);
    // EPG is much stronger evidence than channel name because it
    // reflects what's airing RIGHT NOW.
    //   Dual-team hit in EPG program        → +300 (gold-tier confirm)
    //   Single-team hit at mascot+ tier     → +100 (still confirming)
    //   EPG exists but NEITHER team hits    → −100 (EPG says different
    //     content, even if channel name suggests it) — this is what
    //     catches "MLS TEAM | LAFC" when LAFC is hosting Seattle tonight
    //     and our user is searching for the Rapids game. We DON'T
    //     penalise channels without EPG data at all (many IPTV
    //     channels lack tvg_id, so name-only has to stand on its own).
    if (programResult.bothTeamsBonus > 0) {
      programBonus += 300;
      epgConfirmed = true;
    } else if (programResult.score >= 100) {
      programBonus += 100;
      epgConfirmed = true;
    } else {
      programBonus -= 100;
      epgMismatch = true;
    }
  }

  return {
    score: nameResult.score + programBonus,
    details: {
      nameScore: nameResult.score,
      programBonus,
      epgConfirmed,
      epgMismatch,
      hasEpgProgram: Boolean(channel.currentProgramTitle),
      homeStage: nameResult.homeStage,
      awayStage: nameResult.awayStage,
      homeTier: nameResult.homeTier,
      awayTier: nameResult.awayTier,
      homeMatch: nameResult.homeMatch,
      awayMatch: nameResult.awayMatch,
      leagueBonus: nameResult.leagueBonus,
      programDetails: programResult
    }
  };
}

module.exports = {
  scrub,
  wordContains,
  scoreAliases,
  scoreLeagueContext,
  scoreText,
  matchChannel,
  normalizeLeague,
  LEAGUE_KEYWORDS,
  LEAGUE_SPORT
};
