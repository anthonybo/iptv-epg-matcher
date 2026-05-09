const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const { resolveChannel, resolveStreamUrl, buildFfmpegHttpHeaders } = require('./streamHelpers');

/**
 * Live HLS pipeline for the player (NOT for Chromecast — that one lives
 * in stream.js and re-encodes audio).
 *
 * One ffmpeg process per (sessionId, channelId, sourceId). It reads the
 * upstream TS with the same -reconnect / +discardcorrupt flags as the
 * resilient TS pipe endpoint, then wraps the bytes into HLS segments
 * (-c copy, no transcode). The browser polls index.m3u8 and fetches
 * segments through us, so segment serving is just static-file IO out of
 * a tmp dir.
 *
 * URL layout:
 *   GET /api/stream/hls/:sessionId/:channelId/index.m3u8
 *   GET /api/stream/hls/:sessionId/:channelId/seg-:n.ts
 *
 * Lifecycle:
 *   - First playlist GET spawns ffmpeg + waits up to 10s for the first
 *     segment, then serves the playlist.
 *   - Each subsequent playlist or segment fetch updates lastAccess.
 *   - Idle sweep every 30s tears down ffmpeg + tmp dir if no fetch in 30s.
 */

const FFMPEG_BINARY = process.env.FFMPEG_PATH || 'ffmpeg';
const HLS_ROOT = path.join(os.tmpdir(), 'iptv-hls-player');
const MAX_CONCURRENT_HLS = parseInt(process.env.MAX_HLS_PLAYER_SESSIONS, 10) || 24;
const FIRST_SEGMENT_WAIT_MS = 10000;
const IDLE_TIMEOUT_MS = 30000;
const SWEEP_INTERVAL_MS = 30000;

if (!fs.existsSync(HLS_ROOT)) {
    fs.mkdirSync(HLS_ROOT, { recursive: true });
}

const sessions = new Map(); // key -> { proc, dir, lastAccess, started, channelName }

function sessionKey(sessionId, channelId, sourceId) {
    return `${sessionId}__${channelId}__${sourceId || 'default'}`;
}

function cleanupSession(key, reason = 'cleanup') {
    const sess = sessions.get(key);
    if (!sess) return;
    sessions.delete(key);

    logger.info(`[HLS ${key}] Cleanup (${reason})`);
    if (sess.proc && !sess.proc.killed) {
        try { sess.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
    }
    if (sess.dir && fs.existsSync(sess.dir)) {
        try {
            for (const f of fs.readdirSync(sess.dir)) {
                try { fs.unlinkSync(path.join(sess.dir, f)); } catch (_) { /* skip */ }
            }
            fs.rmdirSync(sess.dir);
        } catch (e) {
            logger.warn(`[HLS ${key}] Failed to remove dir ${sess.dir}: ${e.message}`);
        }
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [key, sess] of sessions.entries()) {
        if (now - sess.lastAccess > IDLE_TIMEOUT_MS) {
            cleanupSession(key, 'idle');
        }
    }
}, SWEEP_INTERVAL_MS);

function spawnFfmpeg({ key, dir, streamUrl, channel }) {
    const playlistPath = path.join(dir, 'index.m3u8');
    const segmentPattern = path.join(dir, 'seg-%d.ts');
    const { userAgent, extraHeaders } = buildFfmpegHttpHeaders(channel);

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
    ];
    if (extraHeaders.length) {
        args.push('-headers', extraHeaders.join('\r\n') + '\r\n');
    }
    args.push(
        // Same upstream-resilience flags as the TS pipe endpoint.
        '-reconnect', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_network_error', '1',
        '-reconnect_on_http_error', '4xx,5xx',
        '-reconnect_delay_max', '30',
        '-rw_timeout', '15000000',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-i', streamUrl,
        // Video passthrough — no transcoding cost, every IPTV upstream
        // we've seen ships H.264/HEVC which the browser MSE handles
        // natively.
        '-c:v', 'copy',
        // Audio: transcode to AAC stereo. Most US sports RSNs (Spectrum
        // Sportsnet LA, FanDuel Sports, BSN, MSG, NESN, etc.) carry
        // AC-3 5.1 surround. Browser MSE only decodes AAC over HLS, so
        // a -c copy passthrough produced FATAL mediaError/
        // bufferAddCodecError on every Dodgers/Lakers/Yankees-style
        // channel — see 2026-05-08 21:51 log where xtream_55086
        // (Spectrum Sportsnet LA) flooded the player with hundreds of
        // codec errors per second until the no-progress watchdog
        // killed it 30s later. Audio transcoding burns ~5-10% of one
        // CPU core per stream, which is well under our budget on a
        // 4-tile multiview, and re-enables the entire RSN tier of
        // channels.
        //   -ac 2  — downmix to stereo (most viewers don't have
        //            5.1 setups in a browser anyway)
        //   -b:a   — 160k is the sweet spot for AAC sports audio
        //   -ar    — 48k matches the source so libavfilter doesn't
        //            insert a resampler
        '-c:a', 'aac',
        '-b:a', '160k',
        '-ac', '2',
        '-ar', '48000',
        '-copyts',
        '-muxdelay', '0',
        '-f', 'hls',
        '-hls_time', '2',
        // 12 segments × 2s = 24s playlist window. delete_segments keeps
        // each file on disk for an extra (segment + playlist) seconds
        // after it rolls off, giving a real ~50s grace period.
        '-hls_list_size', '12',
        '-hls_segment_filename', segmentPattern,
        // delete_segments + append_list + omit_endlist is the canonical
        // rolling-live combo per the FFmpeg HLS muxer docs.
        // We do NOT add independent_segments here even though hls.js
        // would prefer it: that flag writes
        // `#EXT-X-INDEPENDENT-SEGMENTS` into the playlist promising
        // every fragment starts with a keyframe. With `-c copy` from
        // an upstream we don't control, we can't guarantee that — and
        // mismatched first-frames are exactly the "playback froze a
        // few seconds in" symptom (segment 0 plays from the original
        // stream start, segment 1+ start mid-GOP, decoder produces no
        // frames). Without the flag, hls.js inspects each segment
        // header at runtime instead of trusting a global promise.
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_type', 'mpegts',
        playlistPath
    );

    logger.info(`[HLS ${key}] Spawning ffmpeg → ${dir}`);
    const proc = spawn(FFMPEG_BINARY, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-4096);
        text.split('\n').forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            if (/error|fatal|invalid|failed/i.test(trimmed)) {
                logger.warn(`[HLS ${key}] ${trimmed}`);
            }
        });
    });

    proc.on('error', (err) => {
        logger.error(`[HLS ${key}] ffmpeg process error: ${err.message}`);
        cleanupSession(key, 'process_error');
    });

    proc.on('exit', (code, signal) => {
        if (signal === 'SIGKILL' || signal === 'SIGTERM') {
            logger.info(`[HLS ${key}] ffmpeg killed (${signal})`);
        } else if (code === 0) {
            logger.info(`[HLS ${key}] ffmpeg exited cleanly`);
        } else {
            logger.warn(`[HLS ${key}] ffmpeg exited code=${code}. stderr tail: ${stderrTail.split('\n').slice(-3).join(' | ')}`);
        }
        cleanupSession(key, `exit_${code ?? signal}`);
    });

    return proc;
}

async function ensureSession({ sessionId, channelId, sourceId, userId }) {
    const key = sessionKey(sessionId, channelId, sourceId);
    let sess = sessions.get(key);
    if (sess) {
        sess.lastAccess = Date.now();
        return { key, sess };
    }

    if (sessions.size >= MAX_CONCURRENT_HLS) {
        const err = new Error('Too many active HLS sessions');
        err.status = 503;
        throw err;
    }

    const channel = await resolveChannel({ sessionId, channelId, sourceId, userId });
    if (!channel) {
        const err = new Error('Channel not found');
        err.status = 404;
        throw err;
    }
    if (!channel.url) {
        const err = new Error('Channel has no stream URL');
        err.status = 400;
        throw err;
    }

    const streamUrl = await resolveStreamUrl(channel);
    const dir = path.join(HLS_ROOT, key);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const proc = spawnFfmpeg({ key, dir, streamUrl, channel });
    sess = {
        proc,
        dir,
        lastAccess: Date.now(),
        started: Date.now(),
        channelName: channel.name,
    };
    sessions.set(key, sess);

    // Wait for the first segment to land before returning so the client's
    // initial playlist GET sees a populated playlist.
    const playlistPath = path.join(dir, 'index.m3u8');
    const start = Date.now();
    while (Date.now() - start < FIRST_SEGMENT_WAIT_MS) {
        if (fs.existsSync(playlistPath)) {
            const text = fs.readFileSync(playlistPath, 'utf8');
            // Wait for at least one #EXTINF tag — empty playlists are useless.
            if (/#EXTINF/.test(text)) break;
        }
        // ffmpeg may have died already (bad source URL etc). Bail fast.
        if (!sessions.has(key)) {
            const err = new Error('Stream failed to start');
            err.status = 502;
            throw err;
        }
        await new Promise((r) => setTimeout(r, 200));
    }

    return { key, sess };
}

// GET /:sessionId/:channelId/index.m3u8
router.get('/:sessionId/:channelId/index.m3u8', authMiddleware, async (req, res) => {
    try {
        const { sessionId, channelId } = req.params;
        const sourceId = req.query.source_id ? parseInt(req.query.source_id, 10) : null;
        const userId = req.user?.id;

        const { key, sess } = await ensureSession({ sessionId, channelId, sourceId, userId });
        const playlistPath = path.join(sess.dir, 'index.m3u8');

        if (!fs.existsSync(playlistPath)) {
            return res.status(503).json({ error: 'Playlist not ready' });
        }

        // Rewrite segment URLs to absolute paths under our endpoint so
        // hls.js fetches them through the same auth+proxy chain.
        const raw = fs.readFileSync(playlistPath, 'utf8');
        const baseUrl = `/api/stream/hls/${sessionId}/${channelId}`;
        const sourceQs = sourceId ? `?source_id=${sourceId}` : '';
        const rewritten = raw.replace(/^seg-(\d+)\.ts$/gm, `${baseUrl}/seg-$1.ts${sourceQs}`);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewritten);
    } catch (err) {
        const status = err.status || 500;
        logger.error(`[HLS] Playlist error: ${err.message}`);
        if (!res.headersSent) {
            res.status(status).json({ error: err.message });
        }
    }
});

// GET /:sessionId/:channelId/seg-:n.ts
router.get('/:sessionId/:channelId/seg-:n.ts', authMiddleware, (req, res) => {
    const { sessionId, channelId, n } = req.params;
    const sourceId = req.query.source_id ? parseInt(req.query.source_id, 10) : null;
    const key = sessionKey(sessionId, channelId, sourceId);
    const sess = sessions.get(key);
    if (!sess) {
        // Log explicitly — hls.js sees this as a fatal fragLoadError
        // and stops polling, which is exactly the "stream froze a few
        // seconds in" symptom. Visibility into when this happens is
        // worth the log line (we silence successful HLS access in
        // server.js, but errors should always bubble up).
        logger.warn(`[HLS ${key}] seg-${n}.ts requested but session is gone`);
        return res.status(404).json({ error: 'HLS session not found' });
    }
    sess.lastAccess = Date.now();

    const segPath = path.join(sess.dir, `seg-${n}.ts`);
    if (!fs.existsSync(segPath)) {
        // Same logic — hls.js has fallen behind ffmpeg's rolling window
        // and is asking for a segment that's already been deleted. Log
        // so we can see the rate. (See -hls_list_size in spawnFfmpeg.)
        logger.warn(`[HLS ${key}] seg-${n}.ts not on disk (rolled out of window)`);
        return res.status(404).json({ error: 'Segment not found' });
    }

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(segPath);
});

// GET /status — diagnostics
router.get('/status', authMiddleware, (req, res) => {
    const list = [];
    for (const [key, sess] of sessions.entries()) {
        list.push({
            key,
            channel: sess.channelName,
            uptimeSec: Math.round((Date.now() - sess.started) / 1000),
            idleSec: Math.round((Date.now() - sess.lastAccess) / 1000),
        });
    }
    res.json({ count: sessions.size, sessions: list });
});

module.exports = router;
