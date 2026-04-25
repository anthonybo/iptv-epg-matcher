const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const logger = require('../config/logger');
const iptvDatabaseService = require('../services/iptvDatabase');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

const STALKER_USER_AGENT =
    'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

/**
 * Look up a channel from the IPTV DB by sessionId + channelId (+ optional
 * sourceId). Returns a normalised channel object or null.
 */
async function resolveChannel({ sessionId, channelId, sourceId, userId }) {
    const db = await iptvDatabaseService.connect();
    const row = await new Promise((resolve, reject) => {
        db.get(
            `SELECT
                c.channel_id as id,
                c.name,
                c.stream_url as url,
                c.logo_url as logo,
                c.group_title,
                c.tvg_id,
                c.source_type,
                c.source_username,
                c.source_password,
                c.source_url,
                c.source_mac
             FROM iptv_channels c
             JOIN iptv_sources s ON c.source_id = s.id
             WHERE c.channel_id = ?
             ${sourceId ? 'AND s.id = ?' : ''}
             AND (s.session_id = ? OR s.user_id = ?)`,
            sourceId
                ? [channelId, sourceId, sessionId, userId]
                : [channelId, sessionId, userId],
            (err, result) => {
                if (err) reject(err);
                else resolve(result);
            }
        );
    });
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        url: row.url,
        groupTitle: row.group_title,
        source_type: row.source_type,
        source_mac: row.source_mac,
        source_username: row.source_username,
    };
}

/**
 * Stalker portals return a portal.php?action=create_link URL — we have to
 * GET that with the MAC cookie + STB UA, then parse the actual stream URL
 * out of the JSON response. Returns the resolved stream URL (or the
 * original URL on failure / non-Stalker channel).
 */
async function resolveStreamUrl(channel) {
    let streamUrl = channel.url;
    if (!streamUrl?.includes('portal.php') || !streamUrl.includes('action=create_link')) {
        return streamUrl;
    }

    try {
        const resp = await fetch(streamUrl, {
            method: 'GET',
            headers: {
                'User-Agent': STALKER_USER_AGENT,
                'X-User-Agent': 'Model: MAG250; Link: WiFi',
                'Cookie': `mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
            },
            timeout: 10000,
            agent: streamUrl.startsWith('https') ? httpsAgent : httpAgent
        });
        if (!resp.ok) return streamUrl;
        const data = await resp.json();
        if (!data?.js?.cmd) return streamUrl;
        const cmdMatch = data.js.cmd.match(/ffmpeg\s+(.+)/);
        if (!cmdMatch) return streamUrl;
        let freshUrl = cmdMatch[1];

        // Some portals leave stream= empty in the response. The original
        // channel.url has the real stream id — splice it back in.
        const originalCmdMatch = channel.url.match(/cmd=([^&]+)/);
        if (originalCmdMatch) {
            const originalStreamMatch = decodeURIComponent(originalCmdMatch[1]).match(/stream=([^&]+)/);
            const originalStreamId = originalStreamMatch ? originalStreamMatch[1] : null;
            if (originalStreamId && (freshUrl.includes('stream=&') || /stream=(?:&|$)/.test(freshUrl))) {
                freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamId}$1`);
            }
        }

        // Some portals return localhost in the stream URL — rewrite to the
        // portal's actual host.
        if (freshUrl.includes('localhost')) {
            const sourceHost = new URL(channel.url);
            freshUrl = freshUrl.replace(/http:\/\/localhost/g, `${sourceHost.protocol}//${sourceHost.host}`);
        }

        return freshUrl;
    } catch (e) {
        logger.warn(`[Stalker] Fresh-link fetch failed: ${e.message}, falling back to original URL`);
        return streamUrl;
    }
}

/**
 * Build the ffmpeg User-Agent + extra headers for a channel. Stalker
 * sources need MAG200 UA + MAC cookie; everything else gets a generic
 * desktop UA.
 */
function buildFfmpegHttpHeaders(channel) {
    const isStalker = channel?.source_type === 'stalker';
    const userAgent = isStalker
        ? STALKER_USER_AGENT
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36';
    const extra = [];
    if (isStalker) {
        extra.push('X-User-Agent: Model: MAG250; Link: WiFi');
        extra.push(`Cookie: mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`);
    }
    return { userAgent, extraHeaders: extra };
}

module.exports = {
    resolveChannel,
    resolveStreamUrl,
    buildFfmpegHttpHeaders,
    STALKER_USER_AGENT,
};
