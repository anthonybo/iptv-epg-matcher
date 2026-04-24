/**
 * Channel / event relevance scoring helpers used by live-event route handlers.
 */

const FuzzySet = require('fuzzyset');

/**
 * Extract searchable terms from a team name
 * Instead of maintaining a brittle list of mascots, we extract meaningful parts:
 * - The full team name
 * - Individual words (for partial matching)
 * - Location/school name (typically the first word(s) before the mascot)
 */
function extractSearchTerms(teamName) {
  if (!teamName) return [];

  const terms = new Set();
  const cleaned = teamName.trim();

  // Add full name
  terms.add(cleaned);

  // Split into words
  const words = cleaned.split(/\s+/);

  // Add individual significant words (4+ chars, not common words)
  // Using 4 chars to avoid abbreviations like "St." matching "St. Lucia"
  const commonWords = new Set(['the', 'and', 'for', 'state', 'university']);
  words.forEach(word => {
    // Strip trailing punctuation for length check
    const cleanWord = word.replace(/[.,:;!?]$/, '');
    if (cleanWord.length >= 4 && !commonWords.has(cleanWord.toLowerCase())) {
      terms.add(word);
    }
  });

  // For multi-word names, add first word(s) which is typically the location/school
  // e.g., "Temple Owls" -> "Temple", "Villanova Wildcats" -> "Villanova"
  // e.g., "Central State (OH) Marauders" -> "Central State", "Central"
  if (words.length >= 2) {
    // Only add first word if it's meaningful (4+ chars after stripping punctuation)
    const firstWordClean = words[0].replace(/[.,:;!?]$/, '');
    if (firstWordClean.length >= 4) {
      terms.add(words[0]);
    }

    // Handle parenthetical state abbreviations like "(OH)"
    const withoutParens = cleaned.replace(/\s*\([^)]+\)\s*/g, ' ').trim();
    const cleanedWords = withoutParens.split(/\s+/);
    if (cleanedWords.length >= 2) {
      // Add first two words for compound names like "Central State", "West Virginia"
      terms.add(cleanedWords.slice(0, 2).join(' '));
    }
  }

  return Array.from(terms);
}

// Word-boundary containment. Using substring matches caused real-world
// false positives: "Tide" matching "Multideportes" ("mulTIDEportes") or
// "Riptide", "York" matching "Yorkshire", etc. `\b` in JS regexes anchors
// at transitions between `\w` and non-`\w`, which rejects mid-word hits
// but still allows punctuation and whitespace as delimiters ("Tide-Radio",
// "Tide.Radio", "nba tide hd" all match, "Multideportes" does not).
function wordContains(text, term) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`\\b${escaped}\\b`).test(text);
  } catch (_e) {
    return text.includes(term);
  }
}

/**
 * Score one team against a channel name in tiers:
 *   150 — full team name appears as a whole phrase (e.g., "Atlanta Hawks")
 *   100 — just the mascot appears as a whole word (e.g., "Hawks")
 *    50 — just the city appears as a whole word/phrase (e.g., "Atlanta")
 *     0 — no whole-word match
 *
 * Tiering stops city-only hits like "Atlanta Falcons News" from scoring the
 * same as dedicated team channels like "Atlanta Hawks HD". Word boundaries
 * stop partial-word hits like "Tide" matching "Multideportes" or "York"
 * matching "Yorkshire" — those were scoring the same as real team channels
 * and getting auto-filled into slots.
 */
function scoreTeamAgainstChannel(channelLower, teamName) {
  if (!teamName) return { score: 0, tier: null };
  const team = teamName.trim();
  if (!team) return { score: 0, tier: null };

  const full = team.toLowerCase();

  // MLS teams (and some others) end in a league-suffix — FC, SC, CF — that
  // isn't a mascot ("Inter Miami CF", "New York City FC", "Nashville SC",
  // "Atlanta United FC"). The raw mascot check would either use the
  // suffix (fails the length>=4 guard) or, worse, use "FC"/"SC"/"CF" and
  // miss channels that just say "INTER MIAMI". Stripping the suffix
  // before computing mascot/city fixes both.
  const stripped = team.replace(/\s+(FC|SC|CF)$/i, '').trim();
  const strippedWords = stripped.split(/\s+/);
  const mascot = (strippedWords[strippedWords.length - 1] || '').toLowerCase();
  const city = strippedWords.slice(0, -1).join(' ').toLowerCase();

  if (full && wordContains(channelLower, full)) return { score: 150, tier: 'full' };

  // If the suffix-stripped form is still multi-word, treat a hit on
  // that phrase as a full-team match ("INTER MIAMI" counts for
  // "Inter Miami CF"). Single-word stripped forms fall through —
  // matching "Nashville" alone would over-match "Nashville Predators"
  // (NHL) as if we'd seen the real MLS team.
  const strippedLower = stripped.toLowerCase();
  const strippedIsMultiWord = stripped.includes(' ');
  if (strippedIsMultiWord && strippedLower !== full && wordContains(channelLower, strippedLower)) {
    return { score: 150, tier: 'full' };
  }

  // When the team name is effectively just "CITY + league suffix"
  // (Nashville SC / Charlotte FC / Cincinnati FC), the word we'd
  // otherwise treat as "mascot" is actually just the city — matching
  // it shouldn't earn the higher mascot-tier score. Downgrade to
  // city-level so the league-context penalty can correctly push
  // wrong-sport channels ("Nashville Predators", NHL) below minScore.
  if (mascot.length >= 4 && wordContains(channelLower, mascot)) {
    const tier = strippedIsMultiWord ? 'mascot' : 'city';
    const score = strippedIsMultiWord ? 100 : 50;
    return { score, tier };
  }
  if (city.length >= 4 && wordContains(channelLower, city)) return { score: 50, tier: 'city' };
  return { score: 0, tier: null };
}

// League → set of abbreviations / phrases that typically appear in channel
// names for that league. Used for cross-sport disambiguation: if an event
// is MLS, channels with `NHL` / `AHL` / `NBA` in their name are almost
// certainly a different sport (e.g., "AHL 12 | GRAND RAPIDS GRIFFINS"
// matching a Colorado Rapids search via mascot-word "Rapids").
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
  qmjhl: ['qmjhl'],
  khl: ['khl']
};

// Which sport each league belongs to, for cross-sport conflict detection.
const LEAGUE_SPORT = {
  mls: 'soccer',
  epl: 'soccer',
  laliga: 'soccer',
  seriea: 'soccer',
  bundesliga: 'soccer',
  ucl: 'soccer',
  uel: 'soccer',
  nhl: 'hockey',
  ahl: 'hockey',
  qmjhl: 'hockey',
  khl: 'hockey',
  nba: 'basketball',
  wnba: 'basketball',
  cbb: 'basketball',
  nfl: 'football',
  cfb: 'football',
  mlb: 'baseball'
};

// Normalise a free-form league name like "MLS" / "Major League Soccer" /
// "NCAA Football" / "ESP.1" to one of the keys above (or null).
function normalizeLeague(leagueName) {
  if (!leagueName) return null;
  const lower = leagueName.toLowerCase();
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
  if (/\bqmjhl\b/.test(lower)) return 'qmjhl';
  if (/\bncaa\b.*football|\bcfb\b|college football/.test(lower)) return 'cfb';
  if (/\bncaa\b.*basketball|\bcbb\b|college basketball/.test(lower)) return 'cbb';
  if (/\bncaa\b/.test(lower)) return 'ncaa';
  return null;
}

/**
 * Sport / league context bonus (or penalty).
 *
 * + bonus when the channel name clearly advertises the SAME league or sport
 *   we're searching for ("MLS TEAM | LAFC" for an MLS event → +50).
 * − penalty when the channel name advertises a DIFFERENT sport ("AHL 12 |
 *   GRAND RAPIDS GRIFFINS" for an MLS event → −120).
 *
 * This is the fix for the cross-sport false positives we hit on teams
 * with common-word mascots (Rapids, United, City, Union, Kings): without
 * it, a mascot-word hit scored 100 whether the channel was the right
 * league or an AHL hockey team that happened to share a word.
 */
function scoreLeagueContext(channelLower, sportType, leagueName) {
  const targetLeague = normalizeLeague(leagueName);
  const targetSport = (sportType || '').toLowerCase() ||
    (targetLeague ? LEAGUE_SPORT[targetLeague] : null);

  if (!targetLeague && !targetSport) return 0;

  let score = 0;

  // Bonus for same-league keywords.
  if (targetLeague) {
    for (const kw of LEAGUE_KEYWORDS[targetLeague] || []) {
      if (wordContains(channelLower, kw)) {
        score += 50;
        break;
      }
    }
  }

  // Scan for any other known league's keywords. If we find a keyword
  // belonging to a different sport, that's a strong signal the channel
  // is the wrong content and we want to push it below minScore.
  for (const [league, keywords] of Object.entries(LEAGUE_KEYWORDS)) {
    if (league === targetLeague) continue;
    const otherSport = LEAGUE_SPORT[league];
    if (!otherSport || otherSport === targetSport) continue;
    for (const kw of keywords) {
      if (wordContains(channelLower, kw)) {
        score -= 120;
        return score; // one conflict is enough — stop
      }
    }
  }

  return score;
}

/**
 * Calculate relevance score between a channel name and team names.
 *
 * Scoring model (per-team tiers + both-teams bonus + league context + fuzzy fallback):
 *   Per team:   150 full / 100 mascot / 50 city / 0 nothing
 *   Both teams: +200
 *   League:     +50 same-league keyword / −120 conflicting-sport keyword
 *   Fuzzy:      up to +50 per team (only when literal matching found nothing)
 *
 * This replaces the earlier "any-term-contains" substring check, which
 * scored "Atlanta Falcons News" identically to "Atlanta Hawks HD" for a
 * Hawks game — so the per-batch minScore=200 filter dropped real candidates
 * along with false positives. With tiering, a real dedicated-team channel
 * scores 100+, a city-only false positive scores 50, and the two are
 * distinguishable by the caller.
 *
 * The league-context layer was added after we saw MLS "Colorado Rapids"
 * searches match "AHL | GRAND RAPIDS GRIFFINS" at score 100 (common-word
 * mascot "Rapids"). The AHL penalty pushes that to −20 (under minScore)
 * while legitimate "MLS TEAM | LAFC" gets +50 on top of its team hit.
 */
function calculateRelevanceScore(channelName, homeTeam, awayTeam, context = {}) {
  if (!channelName) return 0;
  const channelLower = channelName.toLowerCase();

  const home = scoreTeamAgainstChannel(channelLower, homeTeam);
  const away = scoreTeamAgainstChannel(channelLower, awayTeam);
  let total = home.score + away.score;

  // Both-teams bonus — the channel names the matchup explicitly.
  if (home.score > 0 && away.score > 0) total += 200;

  // League / sport context (optional — only applies when the caller
  // knows the event's sport or league).
  if (context && (context.sportType || context.leagueName)) {
    total += scoreLeagueContext(channelLower, context.sportType, context.leagueName);
  }

  // Fuzzy fallback — only when literal matching found nothing. Typo
  // tolerance for unusual phrasings ("St. Louis" vs "St Louis"), mangled
  // unicode, etc. Bounded to +50 per team so fuzzy can never outscore a
  // real literal match.
  if (home.score === 0 && away.score === 0 && (homeTeam || awayTeam)) {
    const channelWords = channelLower.split(/[\s|:@\-]+/).filter((w) => w.length >= 3);
    if (channelWords.length > 0) {
      const fuzzy = FuzzySet(channelWords);
      const candidates = [];
      for (const team of [homeTeam, awayTeam].filter(Boolean)) {
        const words = team.trim().split(/\s+/);
        const mascot = words[words.length - 1];
        const city = words.slice(0, -1).join(' ');
        if (mascot && mascot.length >= 4) candidates.push(mascot.toLowerCase());
        if (city && city.length >= 4) candidates.push(city.toLowerCase());
      }
      for (const candidate of candidates) {
        const match = fuzzy.get(candidate, null, 0.75);
        if (match && match.length > 0) total += Math.round(match[0][0] * 50);
      }
    }
  }

  return total;
}

module.exports = {
  extractSearchTerms,
  calculateRelevanceScore,
  scoreTeamAgainstChannel,
  scoreLeagueContext,
  normalizeLeague
};
