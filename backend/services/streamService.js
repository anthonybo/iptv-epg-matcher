// services/streamService.js
/**
 * Stream Service - handles streaming functionality
 */
const { fetchStream } = require('../utils/fetchUtils');
const logger = require('../config/logger');

/**
 * Generates a colored log message for stream operations
 * 
 * @param {string} level - Log level (info, success, warn, error, debug)
 * @param {string} message - Log message
 * @param {Object} data - Additional data to log
 */
function logWithColor(level, message, data = {}) {
  const colorCodes = {
    info: '\x1b[36m%s\x1b[0m',    // Cyan
    success: '\x1b[32m%s\x1b[0m',  // Green
    warn: '\x1b[33m%s\x1b[0m',     // Yellow
    error: '\x1b[31m%s\x1b[0m',    // Red
    debug: '\x1b[35m%s\x1b[0m',    // Magenta
  };
  
  const color = colorCodes[level] || colorCodes.info;
  const fullMessage = `[STREAM] ${message}`;
  console.log(color, fullMessage, data);
  
  // Also log to winston with appropriate level
  logger[level === 'success' ? 'info' : level](message, data);
}

/**
 * Constructs a stream URL for a channel
 * 
 * @param {Object} channel - Channel object
 * @param {string} xtreamUsername - Xtream username
 * @param {string} xtreamPassword - Xtream password
 * @param {string} xtreamServer - Xtream server URL
 * @returns {string} Stream URL
 */
function constructStreamUrl(channel, xtreamUsername, xtreamPassword, xtreamServer) {
  let streamUrl = channel.url;
  
  // Handle Xtream provider URLs
  if (xtreamUsername && xtreamPassword && xtreamServer) {
    const baseUrl = xtreamServer.endsWith('/') ? xtreamServer : `${xtreamServer}/`;
    
    if (streamUrl.startsWith('http')) {
      if (streamUrl.includes(baseUrl)) {
        const channelPath = streamUrl.split(baseUrl)[1];
        streamUrl = `${baseUrl}${xtreamUsername}/${xtreamPassword}/${channelPath}`;
      }
    } else {
      streamUrl = `${baseUrl}${xtreamUsername}/${xtreamPassword}/${streamUrl}`;
    }
    
    logWithColor('debug', 'Constructed Xtream URL', { 
      originalUrl: channel.url,
      constructedUrl: streamUrl
    });
  }
  
  return streamUrl;
}

/**
 * Gets headers for stream request
 * 
 * @param {string} xtreamServer - Xtream server URL
 * @returns {Object} Headers object
 */
function getStreamHeaders(xtreamServer) {
  return {
    'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16', // Using VLC user agent often helps
    'Referer': xtreamServer || 'http://localhost:5001/',
    'Accept': '*/*',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };
}

/**
 * Generates an HLS playlist for a TS stream
 * 
 * @param {string} tsStreamUrl - URL of the TS stream
 * @returns {string} M3U8 playlist content
 */
function generateHlsPlaylist(tsStreamUrl) {
  return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
${tsStreamUrl}
#EXT-X-ENDLIST`;
}

/**
 * Streams channel content in TS format
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Object} channel - Channel to stream
 * @param {string} xtreamUsername - Xtream username
 * @param {string} xtreamPassword - Xtream password
 * @param {string} xtreamServer - Xtream server URL
 */
async function streamTs(req, res, channel, xtreamUsername, xtreamPassword, xtreamServer) {
  logWithColor('info', 'Providing TS stream', { channelId: channel.tvgId });
  
  // Construct proper stream URL from the channel
  const streamUrl = constructStreamUrl(channel, xtreamUsername, xtreamPassword, xtreamServer);
  const headers = getStreamHeaders(xtreamServer);

  logWithColor('debug', 'Fetching stream from provider', { 
    streamUrl,
    headers: JSON.stringify(headers)
  });

  try {
    // Fetch the stream
    const response = await fetchStream(streamUrl, headers);

    // Set appropriate CORS headers - vital for browser playback
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    
    // Determine the content type - critical for browser playback
    let contentType = response.headers.get('Content-Type');
    if (!contentType || contentType === 'application/octet-stream') {
      // If undefined or generic, set to video/mp2t for TS streams
      contentType = 'video/mp2t';
    }
    
    logWithColor('success', 'Stream fetch successful', { 
      contentType,
      contentLength: response.headers.get('Content-Length') || 'unknown',
      streamUrl
    });
    
    // Set appropriate headers for the browser
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    // Pipe the stream to the client
    response.body.pipe(res);
    
    // Handle client disconnect
    req.on('close', () => {
      logWithColor('debug', 'Client closed stream connection', { channelId: channel.tvgId });
    });
    
    // Handle stream errors
    response.body.on('error', (err) => {
      logWithColor('error', 'Error in stream', { 
        error: err.message,
        channelId: channel.tvgId
      });
      
      if (!res.headersSent) {
        res.status(500).json({ error: `Stream error: ${err.message}` });
      }
    });
  } catch (e) {
    logWithColor('error', 'Stream fetch error', { 
      error: e.message, 
      stack: e.stack, 
      url: streamUrl 
    });
    
    return res.status(500).json({ error: `Error fetching stream: ${e.message}` });
  }
}

/**
 * Streams channel content in HLS format
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {string} tsStreamUrl - URL of the TS stream
 */
function streamHls(req, res, tsStreamUrl) {
  logWithColor('info', 'Generating HLS playlist');
  
  // Create a standard, simple HLS playlist
  const m3u8Content = generateHlsPlaylist(tsStreamUrl);
  
  // Set proper HLS headers
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  
  logWithColor('success', 'Returning HLS playlist', { 
    contentLength: m3u8Content.length
  });
  
  return res.send(m3u8Content);
}

module.exports = {
  logWithColor,
  constructStreamUrl,
  getStreamHeaders,
  generateHlsPlaylist,
  streamTs,
  streamHls
};