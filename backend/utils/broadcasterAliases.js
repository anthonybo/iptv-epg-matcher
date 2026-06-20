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
  // FOX's streaming bundle (FIFA World Cup events list it alongside FOX/FS1).
  // Without this key it fell through as a verbatim "%FOX One%" no-op term.
  'FOX One': ['FOX ONE', 'FOX SPORTS', 'FS1', 'FS2', 'FOXSPORTS'],
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
  // MLB NETWORK and MLB.TV are DIFFERENT products. MLB Network is a
  // 24/7 linear cable channel (highlights, MLB Tonight, occasional
  // out-of-market games). MLB.TV is a streaming app that carries
  // every live regular-season game. Conflating them makes the matcher
  // surface MLB Network as a candidate for any MLB game when in
  // reality the live broadcast is on the team's RSN — see the
  // 2026-05-08 Dodgers/Braves search log where MLB.TV was an ESPN
  // broadcaster code, the alias bag included MLB NETWORK, and every
  // "CA MLB Network" channel scored +250 broadcaster bonus and beat
  // out Spectrum Sportsnet LA Dodgers (the actual live broadcaster).
  // 'MLB Net' is a real ESPN abbreviation; live-events.broadcasts
  // sometimes returns that for MLB Network — keep it on this entry.
  'MLB Network': ['MLB NETWORK', 'MLBN', 'MLB NET'],
  'MLB.TV': ['MLB.TV', 'MLBTV'],
  'NFL+': ['NFL+', 'NFL PLUS'],

  // Other common ones
  // ESPN sometimes truncates to "Golf Chnl" — expandBroadcaster's
  // reverse-value lookup will find this entry from the abbreviation.
  'Golf Channel': ['GOLF CHANNEL', 'GOLF CHNL'],
  'Tennis Channel': ['TENNIS CHANNEL'],
  'NBC Sports': ['NBC SPORTS', 'NBCSPORTS'],
  'NBC Sports Network': ['NBCSN', 'NBC SPORTS NETWORK'],
  // ESPN sometimes returns these abbreviated regional NBC Sports codes
  // (verified in live_events.broadcasts dump).
  'NBC Sports BA':         ['NBC SPORTS BAY AREA', 'NBC SPORTS CALIFORNIA', 'NBCSBA'],
  'NBC Sports Phil':       ['NBC SPORTS PHILADELPHIA', 'NBCSP'],
  'NBC Sports Boston':     ['NBC SPORTS BOSTON', 'NBCSB'],
  'NBC Sports Chicago':    ['NBC SPORTS CHICAGO', 'NBCSCH'],
  'NBC Sports Washington': ['NBC SPORTS WASHINGTON', 'NBCSW'],
  'CBS Sports': ['CBS SPORTS', 'CBSSPORTS'],
  'CBS Sports Network': ['CBSSN', 'CBS SPORTS NETWORK'],
  'CBS Sports HQ': ['CBS SPORTS HQ'],

  // ── Spanish-language US ──
  // ESPN truncates 'Telemundo' to 'Tele' in some events (verified —
  // 2 FIFA World Cup events arrived with broadcaster code "Tele").
  // Map both to channel name substrings.
  'Telemundo':    ['TELEMUNDO', 'TELEMUNDO INTERNACIONAL'],
  'Tele':         ['TELEMUNDO'],
  // 'Universo' is Telemundo's sister sports channel — carries
  // Premier League soccer in Spanish. Verified in live_events.
  'Universo':     ['UNIVERSO', 'NBC UNIVERSO'],
  // 'Univision' often appears as the Spanish-language partner for
  // Liga MX. TUDN above is Univision's sports package.
  'Univision':    ['UNIVISION'],

  // ── USA Network ──
  // Truncated to 'USA Net' in ESPN data — verified.
  'USA Network':  ['USA NETWORK', 'USANET', 'USA NET'],
  'USA Net':      ['USA NETWORK', 'USANET'],

  // ── Streaming + cable that pop up in real ESPN data ──
  // 'ION' carries WNBA games. 3-char minimum is satisfied; the JS
  // token-boundary regex prevents matching "DOMINION", "ESPNNATION",
  // etc. Verified in IPTV catalog: channels named "ION HD" / "ION".
  // 3-char minimum is satisfied; the JS token-boundary regex prevents
  // matching "DOMINION", "ESPNNATION", etc. SQL ILIKE on '%ION%' will
  // pull in noisy candidates but the JS scorer drops them.
  'ION':          ['ION'],
  'HBO Max':      ['HBO MAX', 'MAX HD', 'HBOMAX'],
  // ESPN's MLB feeds frequently appear as "<Team>.TV" (Padres.TV,
  // Angels.TV, Reds.TV, etc. — verified in live_events). Most IPTV
  // catalogs don't carry team-specific .TV streams as distinct
  // channels; the team game flows through the team's RSN or the
  // MLB.TV streaming app. We map each team-.TV to:
  //   1. The literal "<Team>.TV" / "<Team> TV" string (catches IPTV
  //      catalogs that DO carry the per-team feed)
  //   2. MLB.TV as a fallback (the streaming-app catch-all)
  //
  // We do NOT chain MLB NETWORK in here. MLB Network is a different
  // linear cable channel that does not generally carry the live
  // regular-season game; including it as a fallback alias caused the
  // matcher to surface MLB NETWORK above each team's actual RSN for
  // every MLB game.
  //
  // Below: all 30 MLB clubs. Each entry is a no-op for catalogs that
  // don't carry these streams; for those that do, the explicit name
  // beats a verbatim passthrough.
  'MLB.TV':           ['MLB.TV', 'MLBTV', 'MLB TV'],
  'Angels.TV':        ['ANGELS.TV', 'ANGELS TV',          'MLB.TV'],
  'Astros.TV':        ['ASTROS.TV', 'ASTROS TV',          'MLB.TV'],
  'Athletics.TV':     ['ATHLETICS.TV', 'ATHLETICS TV',    'MLB.TV'],
  'BravesVision':     ['BRAVESVISION', 'BRAVES VISION',   'MLB.TV'],
  'Brewers.TV':       ['BREWERS.TV', 'BREWERS TV',        'MLB.TV'],
  'Cardinals.TV':     ['CARDINALS.TV', 'CARDINALS TV',    'MLB.TV'],
  'CLEGuardians.TV':  ['CLEGUARDIANS.TV', 'GUARDIANS.TV', 'GUARDIANS TV', 'MLB.TV'],
  'DBACKS.TV':        ['DBACKS.TV', 'DBACKS TV', 'DIAMONDBACKS.TV', 'D-BACKS.TV', 'MLB.TV'],
  'Marlins.TV':       ['MARLINS.TV', 'MARLINS TV',        'MLB.TV'],
  'Mariners.TV':      ['MARINERS.TV', 'MARINERS TV',      'MLB.TV'],
  'Mets.TV':          ['METS.TV', 'METS TV',              'MLB.TV'],
  'Nationals.TV':     ['NATIONALS.TV', 'NATIONALS TV',    'MLB.TV'],
  'Orioles.TV':       ['ORIOLES.TV', 'ORIOLES TV',        'MLB.TV'],
  'Padres.TV':        ['PADRES.TV', 'PADRES TV',          'MLB.TV'],
  'Phillies.TV':      ['PHILLIES.TV', 'PHILLIES TV',      'MLB.TV'],
  'Pirates.TV':       ['PIRATES.TV', 'PIRATES TV',        'MLB.TV'],
  'Rangers.TV':       ['RANGERS.TV', 'RANGERS TV',        'MLB.TV'],
  'Rays.TV':          ['RAYS.TV', 'RAYS TV',              'MLB.TV'],
  'Red Sox.TV':       ['RED SOX.TV', 'RED SOX TV',        'MLB.TV'],
  'Reds.TV':          ['REDS.TV', 'REDS TV',              'MLB.TV'],
  'Rockies.TV':       ['ROCKIES.TV', 'ROCKIES TV',        'MLB.TV'],
  'Royals.TV':        ['ROYALS.TV', 'ROYALS TV',          'MLB.TV'],
  'Tigers.TV':        ['TIGERS.TV', 'TIGERS TV',          'MLB.TV'],
  'Twins.TV':         ['TWINS.TV', 'TWINS TV',            'MLB.TV'],
  'White Sox.TV':     ['WHITE SOX.TV', 'WHITE SOX TV',    'MLB.TV'],
  'Yankees.TV':       ['YANKEES.TV', 'YANKEES TV',        'MLB.TV'],
  'Cubs.TV':          ['CUBS.TV', 'CUBS TV',              'MLB.TV'],
  'Blue Jays.TV':     ['BLUE JAYS.TV', 'BLUE JAYS TV',    'MLB.TV'],
  'Giants.TV':        ['GIANTS.TV', 'GIANTS TV',          'MLB.TV'],
  'Dodgers.TV':       ['DODGERS.TV', 'DODGERS TV',        'MLB.TV'],

  // Regional Sports Networks (RSNs) — each owns the rights to a
  // specific franchise's local broadcasts. ESPN names them directly
  // as broadcasters when relevant. IPTV catalogs typically DO carry
  // them as separate channels.
  'MASN':                    ['MASN', 'MID-ATLANTIC SPORTS NETWORK'],
  'MASN2':                   ['MASN2', 'MASN 2'],
  'Marquee Sports Net':      ['MARQUEE SPORTS NETWORK', 'MARQUEE SPORTS', 'MARQUEE'],
  'Sportsnet LA':            ['SPORTSNET LA', 'SNLA'],
  'NBC Sports California':   ['NBC SPORTS CALIFORNIA', 'NBC SPORTS CA', 'NBCSCA'],
  'NBC Sports Bay Area':     ['NBC SPORTS BAY AREA', 'NBC SPORTS BA', 'NBCSBA'],
  'NBC Sports Boston':       ['NBC SPORTS BOSTON', 'NBCSB'],
  'NBC Sports Chicago':      ['NBC SPORTS CHICAGO', 'NBCSCH'],
  'NBC Sports Washington':   ['NBC SPORTS WASHINGTON', 'NBCSW'],
  'NBC Sports Philadelphia': ['NBC SPORTS PHILADELPHIA', 'NBC SPORTS PHIL', 'NBCSP'],
  'CHSN':                    ['CHSN', 'CHICAGO SPORTS NETWORK'],
  'Space City Home Network': ['SPACE CITY HOME NETWORK', 'SCHN', 'SPACE CITY HOME'],
  'MNMT':                    ['MNMT', 'MONUMENTAL SPORTS'],
  'SNY':                     ['SNY', 'SPORTSNET NEW YORK'],
  'Bally Sports':            ['BALLY SPORTS', 'FANDUEL SPORTS NETWORK', 'FANDUEL SPORTS'],
  'Root Sports':             ['ROOT SPORTS'],
  'AT&T SportsNet':          ['AT&T SPORTSNET', 'ATT SPORTSNET'],
  'Rangers Sports Network':  ['RANGERS SPORTS NETWORK'],
  'NESN+':                   ['NESN+', 'NESN PLUS'],

  // Streamers + tiers ESPN names as broadcasters (verified in
  // live_events). ESPN Unlmtd is the unlimited streaming tier — same
  // content surface as ESPN+, so route to its aliases.
  'ESPN Unlmtd':       ['ESPN UNLIMITED', 'ESPN UNLMTD', 'ESPN+', 'ESPNPLUS'],
  'NBA League Pass':   ['NBA LEAGUE PASS', 'NBA TV', 'NBATV'],
  'NHL Network':       ['NHL NETWORK', 'NHLN'],
  'NHL.TV':            ['NHL.TV', 'NHL TV', 'NHL NETWORK'],
  'Prime Video':       ['PRIME VIDEO', 'AMAZON PRIME VIDEO', 'AMAZON PRIME'],
  'Victory+':          ['VICTORY+', 'VICTORY PLUS'],
  'DAZN':              ['DAZN'],
  'fubo':              ['FUBO', 'FUBOTV', 'FUBO TV'],
  'YouTube TV':        ['YOUTUBE TV', 'YOUTUBETV', 'YT TV'],
  'Sling':             ['SLING', 'SLING TV'],
  'Hulu':              ['HULU', 'HULU LIVE'],
  'Disney+':           ['DISNEY+', 'DISNEY PLUS'],
  'The CW Network':    ['THE CW', 'CW NETWORK', 'THE CW NETWORK'],
  'NWSL+':             ['NWSL+', 'NWSL PLUS'],
  // Quebec / French Canadian — TVA Network is the over-the-air French
  // network. Distinct from TVAS (TVA Sports), which is its own entry.
  'TVA':               ['TVA NETWORK', 'TVA HD'],

  // ── Local broadcast affiliates (US) ──
  // ESPN sometimes lists the local affiliate carrying a national or
  // regional game (Dodgers on KTTV, Yankees on WPIX, etc.). IPTV
  // catalogs name these with a mix of call letters, channel numbers,
  // and city tags — we list the most common variants per affiliate.
  // Each entry includes the bare call letters because most catalogs
  // include them somewhere in the channel name; the JS token-boundary
  // regex prevents false positives like "WPIXEL".
  'KCOP':         ['KCOP', 'MY 13', 'LA MY13', 'KCOP-TV'],
  'KTTV':         ['KTTV', 'FOX 11 LA', 'LA FOX 11', 'KTTV-TV'],
  'KING 5':       ['KING 5', 'KING-TV', 'NBC SEATTLE', 'SEATTLE NBC'],
  'KMSP-TV':      ['KMSP', 'FOX 9 MINNEAPOLIS', 'MINNEAPOLIS FOX'],
  'KNTV':         ['KNTV', 'NBC BAY AREA', 'BAY AREA NBC'],
  'KPIX+':        ['KPIX+', 'KPIX PLUS', 'CBS BAY AREA+'],
  'WPIX':         ['WPIX', 'PIX 11', 'PIX11', 'NY PIX 11'],
  'WCIU-TV':      ['WCIU', 'WCIU-TV', 'THE U', 'CHICAGO U'],
  'WWOR-TV':      ['WWOR', 'MY 9', 'NY MY9', 'WWOR-TV'],
  'WMOR':         ['WMOR', 'WMOR-TV', 'TAMPA MYTV', 'TAMPA MY TV'],
  'WXIX FOX19':   ['WXIX', 'FOX 19', 'FOX19', 'CINCINNATI FOX'],
  'WKYC 3':       ['WKYC', 'WKYC 3', 'CHANNEL 3 CLEVELAND', 'NBC CLEVELAND'],
  'CW33':         ['CW33', 'CW 33', 'DALLAS CW', 'DFW CW'],
  'Fox 5 WTTG':   ['WTTG', 'FOX 5 DC', 'FOX 5 WASHINGTON', 'DC FOX 5'],
  'PeachtreeTV':  ['PEACHTREE TV', 'PEACHTREETV', 'WPCH', 'ATLANTA PEACHTREE'],

  // ── Misc streaming / international ──
  // Space City Home Network's secondary audio feed for the Astros —
  // reuse the parent's aliases plus the explicit "(Alt.)" variant.
  'Space City Home (Alt.)': [
    'SPACE CITY HOME NETWORK', 'SPACE CITY HOME', 'SCHN',
    'SPACE CITY HOME ALT', 'SCHN ALT'
  ],
  'Liberty Live':          ['LIBERTY LIVE', 'LIBERTYLIVE', 'LIBERTY UNIVERSITY'],
  'GoHatters.com':         ['GOHATTERS', 'STETSON ATHLETICS', 'HATTERS LIVE'],
  // Mountain West Network — college sports streaming.
  'MWN':                   ['MOUNTAIN WEST NETWORK', 'MWN', 'MW NETWORK'],
  // Polish public sports broadcaster.
  'Polsat Sport':          ['POLSAT SPORT', 'POLSATSPORT'],
  // Romanian Prima Sport family.
  'Prima Sport 2':         ['PRIMA SPORT 2', 'PRIMASPORT2'],
  // South African DStv premium cricket channel — also widely
  // restreamed for international cricket.
  'SuperSport Cricket':    ['SUPERSPORT CRICKET', 'SS CRICKET', 'SUPERSPORT'],
  // German DAZN secondary feed.
  'DAZN 2 Germany':        ['DAZN 2', 'DAZN2', 'DAZN GERMANY', 'DAZN DE'],

  // Gray Media is a holding company that owns 100+ local stations
  // (KMSP, WKYC, KNTV, etc.). When ESPN attributes a broadcast to
  // "Gray Media" the actual airing channel is one of those locals —
  // we don't have enough context to pick the right one, so we map
  // the umbrella name verbatim and rely on the league + team-name
  // matchers to surface the right local station from the candidate
  // pool. (The 'Gray Media' substring appears in some IPTV channel
  // metadata too; this catches that.)
  'Gray Media':            ['GRAY MEDIA', 'GRAY TELEVISION'],
  'Fox Soccer Plus': ['FOX SOCCER'],
  'beIN Sports': ['BEIN SPORTS', 'BEIN'],
  'TUDN': ['TUDN', 'UNIVISION DEPORTES'],
  'YES Network': ['YES NETWORK', 'YES'],
  'NESN': ['NESN'],
  'MSG Network': ['MSG'],

  // ── UK / Ireland — Premier League, EFL, rugby, cricket ────
  // Sky Sports family. The bare brand "Sky Sports" maps to the umbrella
  // string most channel lists use; specific feeds get their own keys
  // so when ESPN/league data names "Sky Sports Football" specifically
  // we don't grab "Sky Sports Cricket".
  'Sky Sports':            ['SKY SPORTS'],
  'Sky Sports Premier League': ['SKY SPORTS PREMIER LEAGUE', 'SKY SPORTS PL'],
  'Sky Sports Football':   ['SKY SPORTS FOOTBALL'],
  'Sky Sports Main Event': ['SKY SPORTS MAIN EVENT', 'SKY SPORTS MAIN'],
  'Sky Sports Cricket':    ['SKY SPORTS CRICKET'],
  'Sky Sports Golf':       ['SKY SPORTS GOLF'],
  'Sky Sports F1':         ['SKY SPORTS F1', 'SKY F1'],
  'Sky Sports News':       ['SKY SPORTS NEWS', 'SKYSPORTSNEWS'],
  'Sky Sports Action':     ['SKY SPORTS ACTION'],
  'Sky Sports Arena':      ['SKY SPORTS ARENA'],
  'Sky Sports Mix':        ['SKY SPORTS MIX'],
  'TNT Sports':            ['TNT SPORTS'], // UK rebrand of BT Sport
  'BT Sport':              ['BT SPORT'],
  'BBC One':               ['BBC ONE', 'BBC1'],
  'BBC Two':               ['BBC TWO', 'BBC2'],
  'BBC Scotland':          ['BBC SCOTLAND'],
  'BBC iPlayer':           ['BBC IPLAYER'],
  // Bare 'ITV' is too generic / 3 chars (the JS scorer's 3-char floor
  // would still let it match "ITV2" via token-boundary because the
  // digit's not allowed after, so 'ITV1'/'ITV 1' is the safe form).
  'ITV':                   ['ITV1', 'ITV 1', 'ITV HD'],
  'ITV4':                  ['ITV4'],
  // 'CHANNEL 4' here lets the JS token-boundary regex distinguish
  // "Channel 4" from "Channel 40" — the regex blocks digit follow-on
  // automatically, so we don't need a trailing-space hack.
  'Channel 4':             ['CHANNEL 4', 'CH4'],

  // Canadian — ESPN's NHL data lists "SN", "SN360", "SN1", "TVAS"
  // etc. as broadcaster codes. Without aliases the matcher would fall
  // back to those raw codes as substrings, and "SN" (2 chars) wrongly
  // matches DISNEY, GENESIS, and any channel containing s-n adjacent.
  // Map each Sportsnet code to the substrings actually found in IPTV
  // channel names.
  'SN':    ['SPORTSNET', 'SN360', 'SN ONE', 'SNPACIFIC', 'SN PACIFIC',
            'SN WEST', 'SN EAST', 'SN ONTARIO', 'SN1'],
  'SN1':   ['SN ONE', 'SN1', 'SPORTSNET ONE'],
  'SN360': ['SN360', 'SN 360', 'SPORTSNET 360'],
  'SNE':   ['SN EAST', 'SPORTSNET EAST'],
  'SNW':   ['SN WEST', 'SPORTSNET WEST'],
  'SNP':   ['SN PACIFIC', 'SPORTSNET PACIFIC'],
  'SNO':   ['SN ONTARIO', 'SPORTSNET ONTARIO'],
  'TSN':   ['TSN'],
  'TSN1':  ['TSN1', 'TSN 1'],
  'TSN2':  ['TSN2', 'TSN 2'],
  'TSN3':  ['TSN3', 'TSN 3'],
  'TSN4':  ['TSN4', 'TSN 4'],
  'TSN5':  ['TSN5', 'TSN 5'],
  'TVAS':  ['TVA SPORTS', 'TVAS'],
  'CBC':   ['CBC'],

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
  // 1. Direct key match
  if (BROADCASTER_ALIASES[trimmed]) return BROADCASTER_ALIASES[trimmed];
  // 2. Case-insensitive key match
  const upper = trimmed.toUpperCase();
  for (const [key, aliases] of Object.entries(BROADCASTER_ALIASES)) {
    if (key.toUpperCase() === upper) return aliases;
  }
  // 3. Reverse lookup — when ESPN sends an abbreviation like "SECN+"
  //    that's not a key but DOES appear in an alias list (the dict
  //    has 'SEC Network+': [..., 'SECN+']), we want to find that
  //    family. Without this, "SECN+" falls through to verbatim and
  //    we miss the SEC NETWORK+ / SEC+ aliases that catch
  //    differently-named IPTV channels.
  for (const aliases of Object.values(BROADCASTER_ALIASES)) {
    if (aliases.some((a) => String(a).toUpperCase() === upper)) return aliases;
  }

  // 4. beIN Sports localized-channel decomposition.
  //    ESPN sends verbose, country-suffixed strings for beIN's
  //    numbered feeds — "beIN Sports HD 1 France", "BeIn Sports 2
  //    France", "beIN SPORTS 1 USA", "beIN Sports Max 4 France", etc.
  //    Our IPTV channels are named "|FR| beIN Sports 1 ᴴᴰ",
  //    "|FR| BEIN SPORT 1 ˢᴰ", "|FR| BeIN Sport Max 6 ᴴᴰ" — the
  //    country is a |XX| prefix and the quality tag is a unicode
  //    superscript, so a verbatim ILIKE of the ESPN string never
  //    matches and the game falls through to a fruitless event-name
  //    search (observed: a live French handball match on
  //    "beIN Sports HD 1 France" found 0 channels despite 5k+ beIN
  //    rows in the DB).
  //
  //    Decompose into brand+number substrings that DO match: we emit
  //    both the "Sports" and singular "Sport" spellings (both occur
  //    in provider names) so the OR-of-ILIKE candidate filter pulls
  //    the right feed into the pool; the relevance scorer + EPG
  //    confirmation rank the correct country variant to the top.
  if (/\bbe\s?in\b/i.test(trimmed)) {
    const numMatch = trimmed.match(/\b(\d{1,2})\b/);
    const isMax = /\bmax\b/i.test(trimmed);
    if (numMatch) {
      const n = numMatch[1];
      if (isMax) {
        return [`beIN Sport Max ${n}`, `beIN Sports Max ${n}`, 'BEIN SPORT MAX'];
      }
      return [`beIN Sports ${n}`, `beIN Sport ${n}`];
    }
    // beIN with no channel number — fall back to the brand family.
    return ['BEIN SPORTS', 'BEIN SPORT', 'BEIN'];
  }

  return [trimmed];
}

/**
 * Did the dict have an explicit entry for this broadcaster code?
 * Distinct from `expandBroadcaster` returning a non-empty array
 * because `expandBroadcaster` returns `[name]` for unmapped codes
 * (so callers don't have to special-case the no-mapping path).
 *
 * Coverage diagnostics need to tell "we have a real alias for this"
 * apart from "we just pass it through" — that's what this answers.
 */
function hasAlias(name) {
  if (!name) return false;
  const trimmed = String(name).trim();
  if (BROADCASTER_ALIASES[trimmed]) return true;
  const upper = trimmed.toUpperCase();
  for (const key of Object.keys(BROADCASTER_ALIASES)) {
    if (key.toUpperCase() === upper) return true;
  }
  for (const aliases of Object.values(BROADCASTER_ALIASES)) {
    if (aliases.some((a) => String(a).toUpperCase() === upper)) return true;
  }
  return false;
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

// Optional Wikidata-fetched supplement. Loaded once at module init.
// Hand-curated entries above take precedence; Wikidata fills gaps for
// long-tail leagues we haven't manually mapped (Catalan Basketball,
// Liga ASOBAL handball, Korean Baduk League, etc.). Refreshed by
// `node backend/scripts/fetchWikidataBroadcasters.js`.
let WIKIDATA_FALLBACKS = {};
try {
  // eslint-disable-next-line global-require
  const wd = require('../config/wikidata_broadcasters.json');
  WIKIDATA_FALLBACKS = wd?.leagues || {};
} catch (_) {
  // File doesn't exist yet — that's fine. Run the script to populate.
}

/**
 * Look up a league's likely broadcasters when ESPN didn't supply any.
 * Returns deduped channel-name substrings ready for SQL ILIKE.
 *
 * Resolution order:
 *   1. Hand-curated LEAGUE_BROADCASTER_FALLBACKS (above).
 *   2. Wikidata-derived WIKIDATA_FALLBACKS (json file). Used only when
 *      no hand-curated entry exists for the league. The Wikidata
 *      payload's broadcaster names are passed through expandBroadcaster
 *      same as the hand-curated ones — common names (Fox Sports, ESPN,
 *      BeIN Sports, etc.) get expanded into channel-name substrings;
 *      unknown names pass through verbatim as a literal substring.
 */
function expandLeagueBroadcastersFallback(leagueName) {
  if (!leagueName) return [];
  const handCurated = LEAGUE_BROADCASTER_FALLBACKS[leagueName];
  if (handCurated) return expandBroadcastersList(handCurated);
  const fromWikidata = WIKIDATA_FALLBACKS[leagueName];
  if (fromWikidata && fromWikidata.length > 0) {
    return expandBroadcastersList(fromWikidata);
  }
  return [];
}

module.exports = {
  BROADCASTER_ALIASES,
  LEAGUE_BROADCASTER_FALLBACKS,
  expandBroadcaster,
  expandBroadcastersList,
  expandLeagueBroadcastersFallback,
  hasAlias,
};
