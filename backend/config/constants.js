// config/constants.js
const path = require('path');

/**
 * Application constants
 */
module.exports = {
  // Cache settings
  CACHE_DIR: path.join(__dirname, '../cache'),
  CACHE_TTL: 24 * 60 * 60 * 1000, // 24 hours in ms
  
  // External EPG sources
  EXTERNAL_EPG_URLS: [
    'https://strongepg.ip-ddns.com/8k-epg.xml.gz',
    'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz',
    // 'https://epgshare01.online/epgshare01/epg_ripper_US1.xml.gz',
    'https://epg.pw/xmltv/epg_US.xml',
    'https://www.open-epg.com/files/unitedstates1.xml.gz',
    'https://open-epg.com/files/sports1.xml',
    'https://epg.starlite.best/utc.xml.gz',
    'https://raw.githubusercontent.com/acidjesuz/epgtalk/master/guide.xml',
    'https://iptv-org.github.io/epg/guides/us/tvguide.com.epg.xml',
    'https://iptv-org.github.io/epg/guides/us/directv.com.epg.xml',
    'https://i.mjh.nz/PlutoTV/us.xml.gz'
  ],
  
  // Stream settings
  STREAM_TIMEOUT: 15000, // 15 seconds
  
  // File paths
  UPLOADS_DIR: path.join(__dirname, '../uploads')
};