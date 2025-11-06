const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { getSession } = require('../utils/storageUtils');
const logger = require('../config/logger');
const sessionStorage = require('../utils/sessionStorage');
const iptvDatabaseService = require('../services/iptvDatabaseService');
const { PassThrough } = require('stream');
const { authMiddleware } = require('../middleware/authMiddleware');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * GET /:sessionId/:channelId
 * Stream a channel by redirecting to the appropriate URL
 * Supports both direct streaming and format conversion
 */
router.get('/:sessionId/:channelId', authMiddleware, async (req, res) => {
    try {
        const { sessionId, channelId } = req.params;
        const format = req.query.format || 'ts'; // Default to ts format
        const userId = req.user?.id; // Get user ID if authenticated

        logger.info(`Stream request for session ${sessionId}, channel ${channelId}, format ${format}, userId ${userId || 'none'}`);

        let channels = [];

        // Try to get channels from database first
        try {
            logger.info(`Fetching channels from IPTV database for streaming session ${sessionId}`);
            const dbResult = await iptvDatabaseService.getChannelsForSession(sessionId, {
                page: 1,
                limit: 999999, // Essentially unlimited - load ALL channels for streaming
                userId: userId // Pass userId for authenticated users - enables per-user channel queries
            });

            if (dbResult && dbResult.channels && dbResult.channels.length > 0) {
                logger.info(`Loaded ${dbResult.channels.length} channels from database for streaming`);

                // Transform channels to match expected format
                channels = dbResult.channels.map(ch => ({
                    id: ch.id,
                    tvgId: ch.tvg?.id || ch.id,
                    name: ch.name,
                    groupTitle: ch.group?.title || '',
                    logo: ch.logo || '',
                    url: ch.url,
                    categories: ch.categories || []
                }));

                // Debug: Log first few channels to see their structure
                const samples = channels.slice(0, 5).map(ch => ({
                    id: ch.id,
                    tvgId: ch.tvgId,
                    name: ch.name
                }));
                logger.info(`Sample channels from database: ${JSON.stringify(samples, null, 2)}`);

                // Debug: Find NHL channels if we're looking for one
                if (channelId.toLowerCase().includes('nhl') || channelId.toLowerCase().includes('699083') || channelId.toLowerCase().includes('xtream')) {
                    const nhlChannels = channels.filter(ch =>
                        ch.name.toLowerCase().includes('nhl') ||
                        ch.id.toLowerCase().includes('nhl') ||
                        ch.id.includes('699083') ||
                        ch.id.includes('xtream')
                    ).slice(0, 10);
                    logger.info(`Found ${nhlChannels.length} NHL/matching channels: ${JSON.stringify(nhlChannels.map(ch => ({
                        id: ch.id,
                        tvgId: ch.tvgId,
                        name: ch.name
                    })), null, 2)}`);
                }
            }
        } catch (dbError) {
            logger.warn(`Error loading channels from database: ${dbError.message}, falling back to in-memory`);
        }

        // Fall back to in-memory session storage if database didn't have channels
        if (channels.length === 0) {
            logger.info(`Falling back to in-memory session storage for streaming`);
            let session = sessionStorage.getSession(sessionId);

            // Check if session exists
            if (!session) {
                logger.error(`Session ${sessionId} not found in memory or database`);
                return res.status(404).json({ error: 'Session not found' });
            }

            // Get channels from session
            if (session.data && session.data.channels && session.data.channels.length > 0) {
                channels = session.data.channels;
                logger.info(`Using ${channels.length} channels from in-memory session`);
            } else {
                logger.error(`Session ${sessionId} has no channels in memory or database`);
                return res.status(404).json({ error: 'No channels loaded for this session' });
            }
        }
        
        // Normalize channelId - either with or without 'channel_' prefix
        let normalizedChannelId = channelId;
        let channel;

        logger.info(`Looking for channel with ID: "${channelId}" among ${channels.length} channels`);

        // Try multiple lookup strategies
        // 1. Try by ID first (most reliable)
        channel = channels.find(ch => ch.id === channelId);
        if (channel) {
            logger.info(`Found channel by ID match`);
        }

        // 2. If not found, try by tvgId
        if (!channel) {
            channel = channels.find(ch => ch.tvgId === channelId);
        }

        // 3. If not found, try adding 'channel_' prefix
        if (!channel && !channelId.startsWith('channel_')) {
            normalizedChannelId = `channel_${channelId}`;
            channel = channels.find(ch => ch.id === normalizedChannelId || ch.tvgId === normalizedChannelId);
            if (channel) {
                logger.info(`Found channel with prefix: ${normalizedChannelId}`);
            }
        }

        // 4. If still not found and has 'channel_' prefix, try without it
        if (!channel && channelId.startsWith('channel_')) {
            normalizedChannelId = channelId.replace(/^channel_/, '');
            channel = channels.find(ch => ch.id === normalizedChannelId || ch.tvgId === normalizedChannelId);
            if (channel) {
                logger.info(`Found channel without prefix: ${normalizedChannelId}`);
            }
        }

        if (!channel) {
            logger.error(`Channel not found: ${channelId} in session ${sessionId}. Tried ID and tvgId lookups.`);
            return res.status(404).json({
                error: 'Channel not found',
                details: `Could not find channel with ID "${channelId}" in session. Make sure the channel is loaded.`
            });
        }
        
        if (!channel.url) {
            logger.error(`No stream URL for channel ${channelId}`);
            return res.status(400).json({ error: 'No stream URL for this channel' });
        }
        
        logger.info(`Streaming channel: ${channel.name} (${normalizedChannelId}) from URL: ${channel.url}`);

        // Handle Stalker portal URLs - extract actual stream URL from cmd parameter
        let streamUrl = channel.url;
        if (channel.url.includes('portal.php') && channel.url.includes('action=create_link')) {
            try {
                // Parse URL to extract cmd parameter
                const url = new URL(channel.url);
                const cmd = url.searchParams.get('cmd');

                if (cmd) {
                    // Extract actual stream URL from cmd (format: "ffmpeg http://...")
                    const match = cmd.match(/ffmpeg\s+(.+)/);
                    if (match && match[1]) {
                        streamUrl = match[1];
                        logger.info(`Extracted Stalker stream URL: ${streamUrl}`);
                    } else {
                        logger.warn(`Could not extract stream URL from Stalker cmd parameter: ${cmd.substring(0, 100)}`);
                    }
                }
            } catch (error) {
                logger.error(`Error parsing Stalker URL: ${error.message}`);
            }
        }

        // Option 1: Simple redirect to the original URL
        if (req.query.redirect === 'true') {
            return res.redirect(streamUrl);
        }
        
        // For HEAD requests, don't try to stream, just check availability
        if (req.method === 'HEAD') {
            try {
                // Test if the URL is reachable
                const testResponse = await fetch(streamUrl, {
                    method: 'HEAD',
                    timeout: 5000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                    }
                });
                
                if (!testResponse.ok) {
                    logger.warn(`Stream URL check failed for ${channelId}: ${testResponse.status} ${testResponse.statusText}`);
                    return res.status(502).json({
                        error: 'Stream source unavailable',
                        details: `Source returned: ${testResponse.status} ${testResponse.statusText}`
                    });
                }
                
                // If we get here, the URL is reachable
                return res.status(200).end();
            } catch (error) {
                let statusCode = 502;
                let errorMessage = 'Stream source unavailable';
                
                // DNS resolution errors
                if (error.code === 'ENOTFOUND') {
                    errorMessage = 'Stream source domain cannot be resolved';
                    logger.error(`DNS resolution failed for stream URL: ${streamUrl}`);
                } else if (error.code === 'ETIMEDOUT' || error.cause?.code === 'ETIMEDOUT') {
                    errorMessage = 'Stream source connection timed out';
                } else if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
                    errorMessage = 'Stream source connection was refused';
                }

                logger.error(`Stream availability check failed: ${error.message}`, {
                    channelId,
                    url: streamUrl,
                    errorCode: error.code || error.cause?.code
                });
                
                return res.status(statusCode).json({
                    error: errorMessage,
                    details: error.message
                });
            }
        }
        
        // Option 2: Proxy the stream with potential format conversion
        // Stream video using pipe (more efficient for large data)
        try {
            // Set appropriate headers for streaming
            res.setHeader('Content-Type', format === 'ts' ? 'video/mp2t' : 'video/mp4');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');

            // Fetch and pipe the stream
            const streamResponse = await fetch(streamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                },
                timeout: 60000, // Increase timeout to 60 seconds
            });
            
            if (!streamResponse.ok) {
                logger.error(`Failed to fetch stream: ${streamResponse.status} ${streamResponse.statusText}`);
                return res.status(502).json({ 
                    error: 'Failed to fetch stream from source',
                    status: streamResponse.status,
                    message: streamResponse.statusText
                });
            }
            
            // Create a pass-through stream for better error handling
            const passThrough = new PassThrough();
            
            // Handle errors on the source stream
            streamResponse.body.on('error', (err) => {
                logger.error(`Source stream error for channel ${channelId}: ${err.message}`);
                passThrough.destroy(err);
            });
            
            // Handle errors on the response stream
            res.on('error', (err) => {
                logger.error(`Response stream error for channel ${channelId}: ${err.message}`);
                streamResponse.body.destroy();
                passThrough.destroy();
            });
            
            // Handle client disconnect
            req.on('close', () => {
                try {
                    logger.info(`Stream closed for channel ${channelId}`);
                    streamResponse.body.destroy();
                    passThrough.destroy();
                } catch (err) {
                    logger.error(`Error closing stream: ${err.message}`);
                }
            });
            
            // Pipe through our pass-through stream for better control
            streamResponse.body.pipe(passThrough).pipe(res);
            
            // Set a timeout on the whole operation
            const streamTimeout = setTimeout(() => {
                logger.warn(`Stream timeout for channel ${channelId}`);
                streamResponse.body.destroy(new Error('Stream timeout'));
                passThrough.destroy(new Error('Stream timeout'));
            }, 300000); // 5 minute timeout
            
            // Clear timeout when stream ends or errors
            passThrough.on('end', () => {
                logger.info(`Stream completed successfully for channel ${channelId}`);
                clearTimeout(streamTimeout);
            });
            
            passThrough.on('error', () => {
                clearTimeout(streamTimeout);
            });
            
        } catch (streamError) {
            // Handle common stream errors
            let errorMessage = 'Error streaming content';
            let statusCode = 500;
            
            // Adjust error message based on specific error types
            if (streamError.code === 'ENOTFOUND' || streamError.message.includes('ENOTFOUND')) {
                errorMessage = 'Stream source cannot be found (DNS resolution failed)';
                statusCode = 502;
            } else if (streamError.code === 'ETIMEDOUT' || streamError.message.includes('ETIMEDOUT')) {
                errorMessage = 'Stream source connection timed out';
                statusCode = 504;
            } else if (streamError.code === 'ECONNREFUSED' || streamError.message.includes('ECONNREFUSED')) {
                errorMessage = 'Stream source connection was refused';
                statusCode = 502;
            }
            
            logger.error(`${errorMessage}: ${streamError.message}`, { 
                error: streamError.message,
                stack: streamError.stack,
                channelId,
                url: channel.url
            });
            
            // If streaming has already started, we can't send a JSON response
            if (!res.headersSent) {
                return res.status(statusCode).json({ 
                    error: errorMessage,
                    details: streamError.message
                });
            }
        }
        
    } catch (error) {
        logger.error(`Stream error: ${error.message}`, { 
            error: error.message,
            stack: error.stack
        });
        
        // Only send response if headers haven't been sent yet
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message });
        }
    }
});

/**
 * GET /xtream/:sessionId/:type/:id
 * Special handler for Xtream format URLs
 */
router.get('/xtream/:sessionId/:type/:id', async (req, res) => {
    try {
        const { sessionId, type, id } = req.params;
        const format = req.query.format || 'ts';
        
        logger.info(`Xtream stream request for session ${sessionId}, type ${type}, id ${id}`);
        
        // Get session data with Xtream credentials
        const session = getSession(sessionId);
        if (!session || !session.xtreamUsername || !session.xtreamPassword || !session.xtreamServer) {
            return res.status(404).json({ error: 'Session not found or no Xtream credentials' });
        }
        
        const { xtreamUsername, xtreamPassword, xtreamServer } = session;
        
        // Construct the Xtream URL
        const xtreamUrl = `${xtreamServer}/live/${xtreamUsername}/${xtreamPassword}/${id}.${format}`;
        
        logger.info(`Proxying Xtream stream: ${xtreamUrl}`);
        
        // Option 1: Simple redirect
        if (req.query.redirect === 'true') {
            return res.redirect(xtreamUrl);
        }
        
        // Option 2: Proxy the stream
        try {
            // Set streaming headers
            res.setHeader('Content-Type', format === 'ts' ? 'video/mp2t' : 'video/mp4');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');
            
            // Fetch and pipe the stream
            const streamResponse = await fetch(xtreamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                }
            });
            
            if (!streamResponse.ok) {
                logger.error(`Failed to fetch Xtream stream: ${streamResponse.status} ${streamResponse.statusText}`);
                return res.status(502).json({ 
                    error: 'Failed to fetch stream from Xtream source',
                    status: streamResponse.status,
                    message: streamResponse.statusText
                });
            }
            
            // Pipe the response directly
            streamResponse.body.pipe(res);
            
            // Handle client disconnect
            req.on('close', () => {
                try {
                    streamResponse.body.destroy();
                    logger.info(`Xtream stream closed for id ${id}`);
                } catch (err) {
                    logger.error(`Error closing Xtream stream: ${err.message}`);
                }
            });
            
        } catch (streamError) {
            logger.error(`Error streaming Xtream content: ${streamError.message}`, {
                error: streamError.message,
                stack: streamError.stack
            });
            
            if (!res.headersSent) {
                return res.status(500).json({ 
                    error: 'Error streaming Xtream content',
                    message: streamError.message
                });
            }
        }
        
    } catch (error) {
        logger.error(`Xtream stream error: ${error.message}`, {
            error: error.message,
            stack: error.stack
        });
        
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message });
        }
    }
});

/**
 * Routes for handling Server-Sent Events (SSE)
 */
const { registerSSEClient, removeSSEClient, broadcastSSEUpdate } = require('../utils/sseUtils');

// Middleware to set SSE headers and prevent connection timeout
function sseHeaders(req, res, next) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Prevent Nginx buffering
  res.flushHeaders();
  
  // Set up a heartbeat to prevent connection timeout
  const heartbeatInterval = setInterval(() => {
    if (!res.finished) {
      try {
        res.write(`:heartbeat ${new Date().toISOString()}\n\n`);
        // Don't use res.flush() here to avoid potential errors
      } catch (error) {
        logger.error(`Error sending heartbeat: ${error.message}`);
        clearInterval(heartbeatInterval);
      }
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000); // Every 30 seconds
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    
    // Get the sessionId from params - check for null or invalid values
    const sessionId = req.params.sessionId || null;
    if (sessionId && sessionId !== 'null' && sessionId !== 'undefined') {
      removeSSEClient(sessionId, res);
    } else {
      logger.warn('Client disconnected with invalid session ID');
    }
  });
  
  next();
}

/**
 * GET /api/stream-updates/:sessionId
 * Establishes an SSE connection for real-time updates
 */
router.get('/:sessionId', sseHeaders, (req, res) => {
  const { sessionId } = req.params;
  
  // Validate session ID
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    logger.error('Invalid session ID provided for SSE connection', { sessionId });
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  
  try {
    // Log the connection
    logger.info(`New SSE connection established for session: ${sessionId}`);
    
    // Register the client
    registerSSEClient(sessionId, res);
    
    // Send initial connection event
    broadcastSSEUpdate({
      type: 'connection',
      message: 'SSE connection established',
      sessionId
    }, sessionId);
    
  } catch (error) {
    logger.error(`Error establishing SSE connection: ${error.message}`, { 
      sessionId, 
      error: error.message 
    });
    res.status(500).end();
  }
});

/**
 * HLS Transcoding for Chromecast Support
 * Converts MPEG-TS streams to HLS format that Chromecast can play
 */

// Store active HLS transcoding sessions
const hlsSessions = new Map();

// Clean up HLS session
function cleanupHLSSession(sessionKey) {
  const session = hlsSessions.get(sessionKey);
  if (session) {
    logger.info(`Cleaning up HLS session: ${sessionKey}`);

    // Kill ffmpeg process
    if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
      session.ffmpegProcess.kill('SIGKILL');
    }

    // Clean up temporary files
    if (session.hlsDir && fs.existsSync(session.hlsDir)) {
      try {
        const files = fs.readdirSync(session.hlsDir);
        files.forEach(file => {
          fs.unlinkSync(path.join(session.hlsDir, file));
        });
        fs.rmdirSync(session.hlsDir);
        logger.info(`Cleaned up HLS directory: ${session.hlsDir}`);
      } catch (err) {
        logger.error(`Error cleaning up HLS directory: ${err.message}`);
      }
    }

    hlsSessions.delete(sessionKey);
  }
}

// Cleanup old HLS sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of hlsSessions.entries()) {
    // Clean up sessions older than 5 minutes with no activity
    if (now - session.lastAccess > 5 * 60 * 1000) {
      logger.info(`Cleaning up inactive HLS session: ${key}`);
      cleanupHLSSession(key);
    }
  }
}, 60 * 1000); // Check every minute

/**
 * GET /:sessionId/:channelId/hls.m3u8
 * Serve HLS playlist for Chromecast
 */
router.get('/:sessionId/:channelId/hls.m3u8', authMiddleware, async (req, res) => {
  try {
    const { sessionId, channelId } = req.params;
    const sessionKey = `${sessionId}_${channelId}`;

    logger.info(`HLS playlist request for ${sessionKey}`);

    // Get or create HLS session
    let hlsSession = hlsSessions.get(sessionKey);

    if (!hlsSession) {
      logger.info(`Creating new HLS transcoding session for ${sessionKey}`);

      // Create temporary directory for HLS segments
      const hlsDir = path.join(os.tmpdir(), 'hls', sessionKey);
      if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
      }

      // Get the stream URL (reuse logic from main stream endpoint)
      const streamReq = { params: { sessionId, channelId }, query: {}, user: req.user };

      // Import the channel lookup logic - we'll need to refactor this
      // For now, make a request to our own stream endpoint to get the URL
      const baseUrl = `http://localhost:${process.env.PORT || 5001}`;
      const streamInfoUrl = `${baseUrl}/api/stream/${sessionId}/${channelId}?redirect=true`;

      logger.info(`Fetching stream URL from: ${streamInfoUrl}`);

      const streamInfoResp = await fetch(streamInfoUrl, {
        redirect: 'manual',
        headers: req.headers
      });

      const streamUrl = streamInfoResp.headers.get('location') || streamInfoResp.url;
      logger.info(`Got stream URL for HLS transcoding: ${streamUrl}`);

      // Start ffmpeg transcoding to HLS
      const playlistPath = path.join(hlsDir, 'playlist.m3u8');
      const segmentPattern = path.join(hlsDir, 'segment%03d.ts');

      const ffmpegArgs = [
        '-i', streamUrl,
        '-c:v', 'copy',           // Copy video codec (no re-encoding for speed)
        '-c:a', 'aac',             // Convert audio to AAC for compatibility
        '-b:a', '128k',
        '-f', 'hls',
        '-hls_time', '4',          // 4 second segments
        '-hls_list_size', '10',     // Keep last 10 segments in playlist
        '-hls_flags', 'delete_segments+append_list',
        '-start_number', '0',
        playlistPath
      ];

      logger.info(`Starting ffmpeg with args: ${ffmpegArgs.join(' ')}`);

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // Only log important messages (errors, not warnings about bitstream issues)
        if (output.includes('error') || output.includes('failed') || output.includes('Invalid')) {
          logger.error(`[ffmpeg ${sessionKey}] ${output}`);
        } else if (output.includes('frame=')) {
          // Log progress occasionally (every frame info line)
          logger.debug(`[ffmpeg ${sessionKey}] ${output.trim()}`);
        }
        // Skip logging bitstream warnings and timestamp discontinuities - they're normal for live streams
      });

      ffmpegProcess.stdout.on('data', (data) => {
        logger.debug(`[ffmpeg stdout ${sessionKey}] ${data.toString()}`);
      });

      ffmpegProcess.on('error', (error) => {
        logger.error(`ffmpeg error for ${sessionKey}: ${error.message}`);
        cleanupHLSSession(sessionKey);
      });

      ffmpegProcess.on('exit', (code) => {
        logger.info(`ffmpeg exited for ${sessionKey} with code ${code}`);
        if (code !== 0) {
          logger.error(`ffmpeg failed for ${sessionKey}, cleaning up`);
          cleanupHLSSession(sessionKey);
        }
      });

      hlsSession = {
        ffmpegProcess,
        hlsDir,
        playlistPath,
        lastAccess: Date.now(),
        startTime: Date.now()
      };

      hlsSessions.set(sessionKey, hlsSession);

      // Wait for first segments to be generated (up to 10 seconds)
      let waitTime = 0;
      const maxWait = 10000;
      const checkInterval = 500;

      while (waitTime < maxWait && !fs.existsSync(playlistPath)) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        waitTime += checkInterval;
      }

      if (!fs.existsSync(playlistPath)) {
        logger.error(`Playlist not created after ${maxWait}ms for ${sessionKey}`);
        // Check if ffmpeg process is still running
        if (ffmpegProcess.killed) {
          logger.error(`ffmpeg process was killed for ${sessionKey}`);
        }
        // List files in the directory
        if (fs.existsSync(hlsDir)) {
          const files = fs.readdirSync(hlsDir);
          logger.info(`Files in HLS dir: ${files.join(', ')}`);
        }
      } else {
        logger.info(`Playlist created after ${waitTime}ms for ${sessionKey}`);
      }
    }

    // Update last access time
    hlsSession.lastAccess = Date.now();

    // Serve the playlist
    if (fs.existsSync(hlsSession.playlistPath)) {
      logger.info(`Serving playlist for ${sessionKey}`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.sendFile(hlsSession.playlistPath);
    } else {
      logger.warn(`Playlist not ready yet for ${sessionKey}, files in dir: ${fs.existsSync(hlsSession.hlsDir) ? fs.readdirSync(hlsSession.hlsDir).join(', ') : 'dir does not exist'}`);
      res.status(503).send('Playlist not ready, please retry');
    }

  } catch (error) {
    logger.error(`Error serving HLS playlist: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /:sessionId/:channelId/segment*.ts
 * Serve HLS segments
 */
router.get('/:sessionId/:channelId/:segment', authMiddleware, (req, res) => {
  try {
    const { sessionId, channelId, segment } = req.params;
    const sessionKey = `${sessionId}_${channelId}`;

    const hlsSession = hlsSessions.get(sessionKey);
    if (!hlsSession) {
      return res.status(404).send('HLS session not found');
    }

    // Update last access time
    hlsSession.lastAccess = Date.now();

    const segmentPath = path.join(hlsSession.hlsDir, segment);

    if (fs.existsSync(segmentPath)) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.sendFile(segmentPath);
    } else {
      logger.warn(`Segment not found: ${segmentPath}`);
      res.status(404).send('Segment not found');
    }

  } catch (error) {
    logger.error(`Error serving HLS segment: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;