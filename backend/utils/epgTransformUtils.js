/**
 * EPG Transform Utilities
 * Handles data transformation and content detection for EPG data
 */

const logger = require('./logger');

/**
 * Convert EPG timestamp format to ISO string
 * Converts "YYYYMMDDHHMMSS +TZTZ" to ISO format or Date object
 */
const convertEPGTimestampToISO = (timestamp) => {
  if (!timestamp) return null;

  try {
    // PostgreSQL returns Date objects, SQLite returns strings
    if (timestamp instanceof Date) {
      return timestamp.toISOString();
    }

    // Handle string timestamps (SQLite format)
    if (typeof timestamp !== 'string') {
      return timestamp.toString();
    }

    // Format: "YYYYMMDDHHMMSS +TZTZ" e.g., "20251030103000 +0000"
    const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/);
    if (!match) return null;

    const [, year, month, day, hour, minute, second, tz] = match;

    // Parse timezone offset
    const tzSign = tz[0];
    const tzHours = parseInt(tz.substring(1, 3));
    const tzMinutes = parseInt(tz.substring(3, 5));
    const tzOffsetMinutes = (tzSign === '+' ? 1 : -1) * (tzHours * 60 + tzMinutes);

    // Create date in the specified timezone
    const date = new Date(Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
      parseInt(second)
    ));

    // Adjust for timezone offset (subtract because EPG timestamps are in local time)
    date.setMinutes(date.getMinutes() - tzOffsetMinutes);

    return date.toISOString();
  } catch (error) {
    logger.error(`Error converting timestamp ${timestamp}: ${error.message}`);
    return null;
  }
};

/**
 * Detect if program content is actually LIVE (sports, live events)
 * Uses category and title pattern matching
 */
const detectLiveContent = (title, category) => {
  if (!title) return false;

  const titleLower = title.toLowerCase();
  const categoryLower = (category || '').toLowerCase();

  // Skip if title already has LIVE prefix (avoid double prefix)
  // Check for both regular "Live:" and small caps "ʟɪᴠᴇ"
  if (/^live:?\s/i.test(title) || title.startsWith('ʟɪᴠᴇ ')) {
    return false;
  }

  // Check title for live sports patterns - STRONGEST INDICATOR
  const livePatterns = [
    / vs\.?\s/i,          // "Team A vs Team B" or "Team A vs. Team B"
    / @ /i,               // "Team A @ Team B"
  ];

  const hasVsPattern = livePatterns.some(pattern => pattern.test(title));

  // Strong indicator - if has vs/@ pattern, it's very likely live sports
  if (hasVsPattern) {
    // But exclude if it says "next game" or similar
    const excludeNext = ['next game', 'upcoming', 'scheduled'];
    const hasExcludeNext = excludeNext.some(pattern => titleLower.includes(pattern));
    return !hasExcludeNext;
  }

  // For titles without vs/@ pattern, be more strict
  // Only match if it has sports category AND specific live event keywords
  const sportsCategories = [
    'sport', 'sports', 'live sport'
  ];

  const hasSportsCategory = sportsCategories.some(sport => categoryLower.includes(sport));

  if (hasSportsCategory) {
    // Keywords that indicate it's a live broadcast (not just sports content)
    const liveBroadcastKeywords = [
      'qualifying', 'practice session', 'free practice',
      'championship', 'playoff', 'semifinal', 'quarterfinal', 'final round'
    ];

    const hasLiveBroadcastKeyword = liveBroadcastKeywords.some(keyword => titleLower.includes(keyword));

    // Exclude obvious non-live content
    const excludePatterns = [
      'replay', 'repeat', 'highlights', 'classic', 'rewind',
      'encore', 'recorded', 'best of', 'top 10', 'greatest',
      'next game', 'upcoming', 'documentary', 'news', 'talk show'
    ];

    const isExcluded = excludePatterns.some(pattern => titleLower.includes(pattern));

    return !isExcluded && hasLiveBroadcastKeyword;
  }

  return false;
};

module.exports = {
  convertEPGTimestampToISO,
  detectLiveContent
};
