/**
 * Stream Routes - handles streaming endpoints
 */
const express = require('express');
const router = express.Router();
const { getSession } = require('../utils/storageUtils');
const { logWithColor, streamTs, streamHls } = require('../services/streamService');

/**
 * GET /api/stream/:sessionId/:channelId
 * Streams a channel by ID with improved error handling and channel ID mapping
 */
router.get('/:sessionId/:channelId', async (req, res) => {
    const { sessionId, channelId } = req.params;
    const forceFormat = req.query.format;

    logWithColor('info', `Stream request received for ${channelId}`, {
        sessionId,
        channelId,
        forceFormat,
        timestamp: new Date().toISOString(),
        clientIp: req.ip || req.headers['x-forwarded-for']
    });

    // Validate session
    const session = getSession(sessionId);
    if (!session) {
        logWithColor('error', 'Session not found', { sessionId });
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        // Find the channel
        const decodedChannelId = decodeURIComponent(channelId);
        logWithColor('debug', `Looking for channel ${decodedChannelId}`, { sessionId });

        let channel = session.channels.find(ch => ch.tvgId === decodedChannelId);

        // If channel not found by tvgId, check if it might be a hash ID that needs to be mapped to an EPG ID
        if (!channel) {
            logWithColor('debug', `Channel not found directly, checking if it's a hash ID that needs mapping`, { channelId: decodedChannelId });

            // Check if we have EPG data that might have a match for this channel
            if (session.epgSources && Object.keys(session.epgSources).length > 0) {
                // Check if there's a matched EPG ID for this channel in matched channels map
                const matchedChannels = session.matchedChannels || {};

                // Loop through all channels to find one with a matching hash ID format
                for (const ch of session.channels) {
                    // If this is a hash-style ID like channel_5225231964fb693ecfaf076ecadd39e4
                    if (ch.tvgId.startsWith('channel_') && ch.tvgId.length > 20) {
                        // Check if there's an EPG match for this channel
                        const mappedEpgId = matchedChannels[ch.tvgId];

                        if (mappedEpgId) {
                            logWithColor('info', `Found mapped EPG ID ${mappedEpgId} for hash ID ${ch.tvgId}`);
                            // If this mapped ID matches what the frontend is requesting, use this channel
                            if (mappedEpgId === decodedChannelId) {
                                channel = ch;
                                logWithColor('info', `Using channel ${ch.name} for EPG ID ${decodedChannelId}`);
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Final check if we found a channel
        if (!channel) {
            // Last resort - try all channels by name
            const channelByName = session.channels.find(ch =>
                ch.name.toLowerCase().includes(decodedChannelId.toLowerCase()) ||
                (decodedChannelId.toLowerCase().includes('nationals') &&
                    ch.name.toLowerCase().includes('washington'))
            );

            if (channelByName) {
                logWithColor('warn', `Found channel by name match instead of ID: ${channelByName.name}`, {
                    requestedId: decodedChannelId,
                    foundId: channelByName.tvgId
                });
                channel = channelByName;
            } else {
                logWithColor('error', `Channel not found: ${decodedChannelId}`, { sessionId });
                return res.status(404).json({
                    error: 'Channel not found',
                    message: `Channel ID ${decodedChannelId} not found in session ${sessionId}. If this channel has EPG data, make sure you've matched it correctly.`
                });
            }
        }

        logWithColor('success', `Channel found: ${channel.name}`, {
            channelName: channel.name,
            groupTitle: channel.groupTitle,
            url: channel.url
        });

        // When explicitly requesting TS format
        if (forceFormat === 'ts') {
            const { xtreamUsername, xtreamPassword, xtreamServer } = session;

            try {
                await streamTs(req, res, channel, xtreamUsername, xtreamPassword, xtreamServer);
            } catch (error) {
                logWithColor('error', 'Error streaming TS content', {
                    error: error.message,
                    stack: error.stack,
                    channelId: channel.tvgId,
                    url: channel.url
                });

                // Send more informative error in proper format
                res.status(500).json({
                    error: 'Stream error',
                    message: `Error streaming channel: ${error.message}`,
                    details: {
                        channelName: channel.name,
                        channelId: channel.tvgId,
                        // Don't include credentials in error response
                        streamUrl: channel.url.replace(/\/\/.*?@/, '//<credentials>@')
                    },
                    suggestions: [
                        "Try a different player type (HLS, TS, VLC)",
                        "Check if your IPTV subscription is still active",
                        "Try a different channel"
                    ]
                });
            }
        }
        // For M3U8/HLS format (default)
        else {
            const tsStreamUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(channel.tvgId)}?format=ts`;
            try {
                streamHls(req, res, tsStreamUrl);
            } catch (error) {
                logWithColor('error', 'Error streaming HLS content', {
                    error: error.message,
                    stack: error.stack,
                    channelId: channel.tvgId
                });

                // Send more informative error
                res.status(500).json({
                    error: 'Stream error',
                    message: `Error creating HLS stream: ${error.message}`,
                    details: {
                        channelName: channel.name,
                        channelId: channel.tvgId
                    },
                    suggestions: [
                        "Try a different player type (TS, VLC)",
                        "Check if your IPTV subscription is still active"
                    ]
                });
            }
        }
    } catch (e) {
        logWithColor('error', 'Unexpected error processing stream', {
            error: e.message,
            stack: e.stack,
            sessionId,
            channelId
        });

        return res.status(500).json({
            error: 'Server error',
            message: e.message,
            suggestions: [
                "Try reloading the page",
                "Check browser console for more details"
            ]
        });
    }
});

/**
 * GET /api/stream-test/:sessionId/:channelId
 * Tests stream availability for a channel
 */
router.get('/test/:sessionId/:channelId', async (req, res) => {
    const { sessionId, channelId } = req.params;

    const session = getSession(sessionId);
    if (!session) {
        return res.json({ error: 'Session not found' });
    }

    try {
        const decodedChannelId = decodeURIComponent(channelId);
        const channel = session.channels.find(ch => ch.tvgId === decodedChannelId);

        if (!channel) {
            return res.json({
                error: 'Channel not found',
                message: `Channel ID ${decodedChannelId} not found in session ${sessionId}`
            });
        }

        // Get original URL
        let originalUrl = channel.url;

        // Construct Xtream URL if needed
        let xtreamUrl = originalUrl;
        const { xtreamUsername, xtreamPassword, xtreamServer } = session;

        if (xtreamUsername && xtreamPassword && xtreamServer) {
            const baseUrl = xtreamServer.endsWith('/') ? xtreamServer : `${xtreamServer}/`;

            if (originalUrl.startsWith('http')) {
                if (originalUrl.includes(baseUrl)) {
                    const channelPath = originalUrl.split(baseUrl)[1];
                    xtreamUrl = `${baseUrl}${xtreamUsername}/${xtreamPassword}/${channelPath}`;
                }
            } else {
                xtreamUrl = `${baseUrl}${xtreamUsername}/${xtreamPassword}/${originalUrl}`;
            }
        }

        // Test URL accessibility
        let urlTestResult;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(xtreamUrl, {
                method: 'HEAD',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                }
            });

            clearTimeout(timeoutId);

            urlTestResult = {
                accessible: response.ok,
                status: response.status,
                statusText: response.statusText,
                contentType: response.headers.get('Content-Type'),
                contentLength: response.headers.get('Content-Length')
            };
        } catch (error) {
            urlTestResult = {
                accessible: false,
                error: error.message
            };
        }

        // Return all gathered information
        res.json({
            channelInfo: {
                name: channel.name,
                tvgId: channel.tvgId,
                groupTitle: channel.groupTitle
            },
            urls: {
                original: originalUrl,
                xtream: xtreamUrl,
                streamEndpoint: `http://localhost:5001/api/stream/${sessionId}/${channelId}`
            },
            urlTest: urlTestResult,
            xtreamConfig: {
                server: xtreamServer,
                hasCredentials: !!(xtreamUsername && xtreamPassword)
            }
        });
    } catch (error) {
        res.json({ error: error.message, stack: error.stack });
    }
});

module.exports = router;