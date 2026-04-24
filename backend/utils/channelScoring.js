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
  const words = team.split(/\s+/);
  const mascot = (words[words.length - 1] || '').toLowerCase();
  const city = words.slice(0, -1).join(' ').toLowerCase();

  if (full && wordContains(channelLower, full)) return { score: 150, tier: 'full' };
  if (mascot.length >= 4 && wordContains(channelLower, mascot)) return { score: 100, tier: 'mascot' };
  if (city.length >= 4 && wordContains(channelLower, city)) return { score: 50, tier: 'city' };
  return { score: 0, tier: null };
}

/**
 * Calculate relevance score between a channel name and team names.
 *
 * Scoring model (per-team tiers, additive + both-teams bonus + fuzzy fallback):
 *   Per team: 150 full / 100 mascot / 50 city / 0 nothing
 *   Bonus:   +200 when BOTH teams have any literal hit (that's almost always
 *            the game's versus channel, e.g. "KNICKS @ HAWKS NBA 04")
 *   Fuzzy:   only if nothing matched literally, up to +50 per team (typos)
 *
 * This replaces the earlier "any-term-contains" substring check, which
 * scored "Atlanta Falcons News" identically to "Atlanta Hawks HD" for a
 * Hawks game — so the per-batch minScore=200 filter dropped real candidates
 * along with false positives. With tiering, a real dedicated-team channel
 * scores 100+, a city-only false positive scores 50, and the two are
 * distinguishable by the caller.
 */
function calculateRelevanceScore(channelName, homeTeam, awayTeam) {
  if (!channelName) return 0;
  const channelLower = channelName.toLowerCase();

  const home = scoreTeamAgainstChannel(channelLower, homeTeam);
  const away = scoreTeamAgainstChannel(channelLower, awayTeam);
  let total = home.score + away.score;

  // Both-teams bonus — the channel names the matchup explicitly.
  if (home.score > 0 && away.score > 0) total += 200;

  // Fuzzy fallback — only when literal matching found nothing. Typo
  // tolerance for unusual phrasings ("St. Louis" vs "St Louis"), mangled
  // unicode, etc. Bounded to +50 per team so fuzzy can never outscore a
  // real literal match.
  if (total === 0 && (homeTeam || awayTeam)) {
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
  scoreTeamAgainstChannel
};
