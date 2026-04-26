/**
 * Broadcaster name → channel-name search aliases.
 *
 * ESPN's event metadata includes a broadcasts array like ["B1G+"] or
 * ["TBS"] or ["ESPN+"]. The same broadcaster shows up under several
 * names in IPTV channel lists (Big Ten Plus = BTN+ = B1G+, ESPN Plus =
 * ESPN+ = ESPNPLUS, etc.) — without a translation layer we'd search
 * for "B1G+" and miss every ":BTN+ 25" channel in the user's database.
 *
 * Each entry maps a canonical ESPN name to the substrings we expect to
 * find inside IPTV channel names. Substrings are case-insensitive and
 * are used as ILIKE patterns by the search-channel matcher.
 */

const BROADCASTER_ALIASES = {
  // Big Ten — ESPN says B1G+, the world says BTN+, BTN, Big Ten
  'B1G+': ['B1G+', 'BTN+', 'B1G PLUS', 'BIG TEN PLUS'],
  'BTN': ['BTN', 'B1G', 'BIG TEN'],

  // ESPN family
  'ESPN': ['ESPN'],
  'ESPN+': ['ESPN+', 'ESPNPLUS', 'ESPN PLUS'],
  'ESPN2': ['ESPN2'],
  'ESPN3': ['ESPN3'],
  'ESPNU': ['ESPNU'],
  'ESPNEWS': ['ESPNEWS'],
  'ESPN Deportes': ['ESPN DEPORTES', 'DEPORTES'],

  // Conference networks (often with a "+" or "Extra" streaming variant)
  'ACC Network': ['ACC NETWORK', 'ACCN'],
  'ACC Extra': ['ACC EXTRA', 'ACCNX'],
  'SEC Network': ['SEC NETWORK', 'SECN'],
  'SEC Network+': ['SEC NETWORK+', 'SEC+', 'SECN+'],
  'Pac-12 Network': ['PAC-12', 'PAC 12', 'PACN'],
  'Longhorn Network': ['LONGHORN'],

  // Major US broadcast / cable
  'TBS': ['TBS'],
  'TNT': ['TNT'],
  'truTV': ['TRUTV'],
  'CBS': ['CBS'],
  'NBC': ['NBC'],
  'FOX': ['FOX SPORTS', 'FS1', 'FS2', 'FOXSPORTS'],
  'FS1': ['FS1', 'FOX SPORTS 1'],
  'FS2': ['FS2', 'FOX SPORTS 2'],
  'ABC': ['ABC'],

  // Streaming services
  'Peacock': ['PEACOCK'],
  'Paramount+': ['PARAMOUNT+', 'PARAMOUNT PLUS'],
  'Apple TV+': ['APPLE TV', 'APPLETV'],
  'Amazon Prime Video': ['PRIME VIDEO', 'AMAZON PRIME'],
  'Max': ['HBO MAX', 'MAX'],

  // League-owned
  'NFL Network': ['NFL NETWORK', 'NFLN'],
  'NBA TV': ['NBA TV', 'NBATV'],
  'NHL Network': ['NHL NETWORK', 'NHLN'],
  'MLB Network': ['MLB NETWORK', 'MLBN'],
  'MLB.TV': ['MLB.TV', 'MLBTV'],
  'NFL+': ['NFL+', 'NFL PLUS'],

  // Other common ones
  'Golf Channel': ['GOLF CHANNEL'],
  'Tennis Channel': ['TENNIS CHANNEL'],
  'NBC Sports Network': ['NBCSN', 'NBC SPORTS NETWORK'],
  'CBS Sports Network': ['CBSSN', 'CBS SPORTS NETWORK'],
  'Fox Soccer Plus': ['FOX SOCCER'],
  'beIN Sports': ['BEIN SPORTS', 'BEIN'],
  'TUDN': ['TUDN', 'UNIVISION DEPORTES'],
  'YES Network': ['YES NETWORK', 'YES'],
  'NESN': ['NESN'],
  'MSG Network': ['MSG'],

  // College conferences / streaming
  'BTN+': ['BTN+', 'B1G+'],
  'FloSports': ['FLOSPORTS', 'FLO HOOPS', 'FLO BASEBALL', 'FLO RACING', 'FLO WRESTLING'],
  'B1G+': ['B1G+', 'BTN+'],

  // ── Australian ───────────────────────────────────────────────
  // Fox Sports 501-507 channels — substrings include the channel
  // number to avoid catching the unrelated 'FOX SPORTS' US lineup.
  'Fox Sports AU': [
    'FOX SPORTS 501', 'FOX SPORTS 502', 'FOX SPORTS 503',
    'FOX SPORTS 504', 'FOX SPORTS 505', 'FOX SPORTS 506',
    'FOX SPORTS 507', 'FOX SPORTS AU', 'FOX CRICKET', 'FOX LEAGUE',
    'FOX FOOTY'
  ],
  'Fox Cricket': ['FOX CRICKET', 'FOX SPORTS 501'],
  'Fox League':  ['FOX LEAGUE',  'FOX SPORTS 502'],
  'Fox Footy':   ['FOX FOOTY'],
  // AU-specific qualifier prefixes ('AU: CHANNEL 9', '|AU| Channel 9')
  // keep us off Bangladesh's BD | CHANNEL 9.
  'Channel 9 AU': [
    'AU: CHANNEL 9', '|AU| CHANNEL 9',
    'CHANNEL 9 (ADELAIDE)', 'CHANNEL 9 (BRISBANE)',
    'CHANNEL 9 (MELBOURNE)', 'CHANNEL 9 (PERTH)', 'CHANNEL 9 (SYDNEY)',
    'CHANNEL 9 ADELAIDE', 'CHANNEL 9 BRISBANE',
    'CHANNEL 9 MELBOURNE', 'CHANNEL 9 PERTH',  'CHANNEL 9 SYDNEY'
  ],
  'Channel 7 AU': ['AU: CHANNEL 7', '|AU| CHANNEL 7', 'CHANNEL 7 ADELAIDE', 'CHANNEL 7 SYDNEY'],
  '10 Sport AU': ['10 SPORT 01', '10 SPORT 02', '10 SPORT 03', '10 SPORT 04'],
  'Kayo Sports':   ['KAYO'],
  'Optus Sport':   ['OPTUS SPORT'],
  'beIN Sports AU': ['AU | BEIN SPORTS', 'AU: BEIN SPORTS'],

  // ── Indian / Cricket ────────────────────────────────────────
  'Star Sports':  ['STAR SPORTS'],
  'Sport18':      ['SPORT18', 'SPORTS18'],
  'Willow':       ['WILLOW'],
  'JioCinema':    ['JIOCINEMA', 'JIO CINEMA'],
  'Hotstar':      ['HOTSTAR'],
  'Sony Sports':  ['SONY SPORTS', 'SONY TEN', 'SONY SIX'],

  // ── South American ──────────────────────────────────────────
  'Premiere':     ['PREMIERE'],
  'SporTV':       ['SPORTV'],
  'Globo':        ['GLOBO ESPORTE', 'GLOBOSAT'],
  'TyC Sports':   ['TYC SPORTS'],
  'ESPN Argentina': ['ESPN ARGENTINA', 'ESPN AR'],
  'TNT Sports Argentina': ['TNT SPORTS ARGENTINA'],
  'Fox Sports MX': ['FOX SPORTS MX', 'FOX SPORTS MEXICO'],

  // ── Asian ────────────────────────────────────────────────────
  'DAZN Japan':   ['DAZN JAPAN', 'DAZN JP'],
  'Coupang Play': ['COUPANG'],
  'tvN Sports':   ['TVN SPORTS'],

  // ── Middle East / Africa ───────────────────────────────────
  'SSC Sports':    ['SSC SPORTS', 'SSC1', 'SSC2', 'SSC3', 'SSC4'],
  'beIN Sports MENA': ['BEIN SPORTS MENA', 'BEIN SPORTS HD ARABIA']
};

// ─── League → broadcaster fallback ─────────────────────────────────
// ESPN's API only supplies the `broadcasts` field reliably for North-
// American leagues. For everyone else (J League, A-League, K-League,
// IPL, Brasileirão, Argentine Primera, Aussie Netball/AFL/NRL, etc.)
// the field comes back empty, so the matcher had nothing to anchor
// against and the team-name search picked up cross-sport collisions
// instead (e.g. "Mavericks" → NBA, "Firebirds" → AHL hockey).
//
// This is the hand-curated fallback the search-channel route uses
// when an event's broadcasts[] is empty but its league_name is known.
// Each entry is a list of canonical broadcaster keys from
// BROADCASTER_ALIASES above; expandLeagueBroadcastersFallback walks
// each through expandBroadcaster() to flatten into channel-name
// substrings ready for SQL ILIKE.
const LEAGUE_BROADCASTER_FALLBACKS = {
  // Australian
  'Australian Super Netball League': ['Fox Sports AU', 'Channel 9 AU'],
  'UK Netball Superleague':          ['Sky Sports'],
  'AFL':                              ['Fox Sports AU', 'Fox Footy', 'Channel 7 AU'],
  'AFLW':                             ['Fox Sports AU', 'Fox Footy', 'Channel 7 AU'],
  'NRL':                              ['Fox Sports AU', 'Fox League', 'Channel 9 AU'],
  'Big Bash':                         ['Fox Sports AU', 'Fox Cricket', '10 Sport AU'],
  'A-League':                         ['Channel 10', '10 Sport AU', 'Paramount+'],

  // Cricket — ESPN doesn't cover cricket scores at all so these come
  // from theSportsDB schedule; no broadcaster info.
  'Indian Premier League':            ['Star Sports', 'Sport18', 'JioCinema', 'Willow', 'Hotstar'],
  'IPL':                              ['Star Sports', 'Sport18', 'JioCinema', 'Willow', 'Hotstar'],
  'Pakistan Super League':            ['PTV Sports', 'A Sports', 'Willow'],
  'Cricket World Cup':                ['Star Sports', 'Willow', 'Sky Sports'],

  // Soccer — non-major leagues
  'J League':                         ['DAZN Japan'],
  'K League':                         ['Coupang Play', 'tvN Sports'],
  'Saudi Pro League':                 ['SSC Sports', 'beIN Sports MENA'],
  'Brasileirão Série A':              ['Premiere', 'SporTV', 'Globo'],
  'Brasileirão Série B':              ['Premiere', 'SporTV'],
  'Argentine Primera':                ['TyC Sports', 'ESPN Argentina', 'TNT Sports Argentina'],
  'Liga MX':                          ['TUDN', 'Fox Sports MX', 'ESPN Deportes'],
  'Ascenso MX':                       ['TUDN', 'Fox Sports MX'],

  // Hockey — non-NHL
  'DEL':                              ['MagentaSport', 'Sport1'],

  // Basketball — non-NBA
  'EuroLeague':                       ['DAZN', 'Sport1'],
  'EuroCup':                          ['DAZN'],
  'Italian Lega Basket':              ['Eurosport'],
  'Polish Basketball League':         ['Polsat Sport'],

  // Handball
  'German Handball-Bundesliga':       ['Sky Sports', 'DAZN'],

  // International friendlies / world cups
  'International Friendlies Ice Hockey': [],
  'Slovak Extraliga':                 ['JOJ Sport']
};

/**
 * Resolve a broadcaster name to an array of search aliases. Falls back
 * to the broadcaster name itself when no entry exists, so unknown
 * broadcasters still drive a name-only search.
 */
function expandBroadcaster(name) {
  if (!name) return [];
  const trimmed = String(name).trim();
  // Direct match
  if (BROADCASTER_ALIASES[trimmed]) return BROADCASTER_ALIASES[trimmed];
  // Case-insensitive lookup
  const upper = trimmed.toUpperCase();
  for (const [key, aliases] of Object.entries(BROADCASTER_ALIASES)) {
    if (key.toUpperCase() === upper) return aliases;
  }
  return [trimmed];
}

/**
 * Given an array of ESPN broadcast names, return a deduped set of
 * channel-name search substrings to OR into the SQL filter.
 */
function expandBroadcastersList(names) {
  const out = new Set();
  for (const n of names || []) {
    for (const a of expandBroadcaster(n)) {
      if (a) out.add(a);
    }
  }
  return Array.from(out);
}

/**
 * Look up a league's likely broadcasters when ESPN didn't supply any.
 * Returns deduped channel-name substrings ready for SQL ILIKE.
 */
function expandLeagueBroadcastersFallback(leagueName) {
  if (!leagueName) return [];
  const broadcasters = LEAGUE_BROADCASTER_FALLBACKS[leagueName];
  if (!broadcasters) return [];
  return expandBroadcastersList(broadcasters);
}

module.exports = {
  BROADCASTER_ALIASES,
  LEAGUE_BROADCASTER_FALLBACKS,
  expandBroadcaster,
  expandBroadcastersList,
  expandLeagueBroadcastersFallback,
};
