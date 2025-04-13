// config/constants.js
const path = require('path');

/**
 * Application constants
 */
module.exports = {
    // Cache settings
    CACHE_DIR: path.join(__dirname, '../cache'),
    CACHE_TTL: 24 * 60 * 60 * 1000, // 24 hours in ms
    EPG_CACHE_TTL_HOURS: 12, // 12 hours - reduced from 24 for more frequent updates

    // External EPG sources
    EXTERNAL_EPG_URLS: [
        // 'https://strongepg.ip-ddns.com/8k-epg.xml.gz',
        'https://strongepg.ip-ddns.com/epg/w-8k-epg.xml.gz',
        'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz',
        // 'https://epgshare01.online/epgshare01/epg_ripper_US1.xml.gz',
        'https://epg.pw/xmltv/epg_US.xml',
        'https://www.open-epg.com/files/unitedstates1.xml.gz',
        'https://open-epg.com/files/sports1.xml',
        'https://epg.starlite.best/utc.xml.gz',
        'https://raw.githubusercontent.com/acidjesuz/epgtalk/master/guide.xml',
        // Removed non-working sources
        // 'https://iptv-org.github.io/epg/guides/us/tvguide.com.epg.xml',
        // 'https://iptv-org.github.io/epg/guides/us/directv.com.epg.xml',
        'https://i.mjh.nz/PlutoTV/us.xml.gz'
    ],

    // Stream settings
    STREAM_TIMEOUT: 30000, // 30 seconds - increased from 15

    // File paths
    UPLOADS_DIR: path.join(__dirname, '../uploads'),

    MAX_EPG_SOURCES: 8, // Maximum number of sources to load
    PRIORITY_EPG_SOURCES: [
        'https://strongepg.ip-ddns.com/epg/w-8k-epg.xml.gz',
        'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz'
    ],
    
    // XML processing limits - UPDATED for better handling of large files
    XML_MAX_SIZE_MB: 2000, // Maximum size of XML file to process (2GB) - increased from 500MB
    MAX_CHANNELS_PER_SOURCE: 10000, // Maximum channels to process per source - increased from 5000
    MAX_PROGRAMS_PER_CHANNEL: 500, // Maximum programs to keep per channel - reduced from 1000 to save memory
    
    // Memory management - UPDATED for better memory usage
    CHUNKING_THRESHOLD: 50, // Save programs to disk after this many per channel - reduced from 100
    FORCE_GC_AFTER_PROGRAMS: 50000, // Force garbage collection after processing this many programs - reduced from 100000
    
    // Streaming parameters - UPDATED for better streaming performance
    MAX_BUFFER_SIZE_MB: 64, // Maximum buffer size for streaming - reduced from 200MB to avoid memory issues
    STREAM_CHUNK_SIZE: 32 * 1024, // 32KB chunk size for streaming - reduced from 64KB
    
    // New settings for EPG streaming parser
    STREAM_PARSER_BUFFER_SIZE: 16 * 1024, // 16KB buffer for SAX parser
    STREAM_PARSER_NORMALIZE: false, // Don't normalize text to save memory
    STREAM_PARSER_BATCH_SIZE: 1000, // Process SAX events in batches of 1000
    
    // Database settings
    DB_BATCH_SIZE: 500, // Insert records in batches of 500
    DB_JOURNAL_MODE: 'WAL', // Use Write-Ahead Logging for better performance
    DB_SYNCHRONOUS: 'NORMAL', // Less strict durability for better performance
    
    // Error handling
    MAX_RETRIES: 3, // Maximum number of retries for operations
    RETRY_DELAY_MS: 1000 // Delay between retries in milliseconds
};