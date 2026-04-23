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

/**
 * Calculate relevance score between a channel name and team names using fuzzy matching
 * Returns a score from 0-400 based on how well the channel matches the teams
 */
function calculateRelevanceScore(channelName, homeTeam, awayTeam) {
  const channelLower = channelName.toLowerCase();
  let score = 0;

  // Extract search terms for each team
  const homeTerms = extractSearchTerms(homeTeam);
  const awayTerms = extractSearchTerms(awayTeam);

  // Check for exact substring matches first (fastest)
  const hasHomeMatch = homeTerms.some(term => channelLower.includes(term.toLowerCase()));
  const hasAwayMatch = awayTerms.some(term => channelLower.includes(term.toLowerCase()));

  // Both teams = highest priority
  if (hasHomeMatch && hasAwayMatch) {
    score += 200;
  }

  // Individual team matches
  if (hasHomeMatch) score += 100;
  if (hasAwayMatch) score += 100;

  // If no exact matches, try fuzzy matching for typo tolerance
  if (!hasHomeMatch && !hasAwayMatch && (homeTeam || awayTeam)) {
    // Build fuzzy set from channel name words
    const channelWords = channelLower.split(/[\s|:@\-]+/).filter(w => w.length >= 3);
    if (channelWords.length > 0) {
      const fuzzyChannel = FuzzySet(channelWords);

      // Check if any team term fuzzy matches channel words
      const allTerms = [...homeTerms, ...awayTerms];
      for (const term of allTerms) {
        if (term.length < 3) continue;
        const match = fuzzyChannel.get(term.toLowerCase(), null, 0.7);
        if (match && match.length > 0) {
          // Fuzzy match found - add partial score based on match quality
          score += Math.round(match[0][0] * 50);
        }
      }
    }
  }

  return score;
}

module.exports = {
  extractSearchTerms,
  calculateRelevanceScore
};
