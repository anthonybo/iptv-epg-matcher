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

module.exports = {
  BROADCASTER_ALIASES,
  expandBroadcaster,
  expandBroadcastersList,
};
