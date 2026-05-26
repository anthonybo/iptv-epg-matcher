const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const logger = require('../config/logger');
const postgresService = require('./postgresService');

/**
 * ffmpegService — VOD probe + transmux/transcode pipeline.
 *
 * Three tools exposed:
 *
 *   - probeStream(url, headers?)
 *       Runs `ffprobe` with small probesize/analyzeduration on the
 *       upstream and returns { container, vcodec, acodec, width, height,
 *       duration, vbitrate, abitrate }. Cached in the vod_probe_cache
 *       table by SHA-1 of the URL — same upstream URL = same codecs,
 *       and Xtream stream URLs are deterministic per stream_id so cache
 *       hit rates are effectively 100%.
 *
 *   - spawnPipeline(url, headers, mode, opts)
 *       Spawns ffmpeg with the right flags for the chosen mode and
 *       returns the child process. Caller pipes proc.stdout into res.
 *       Modes:
 *         'copy'         — `-c copy` fragmented MP4, ~5% CPU. Use when
 *                          upstream video + audio are already
 *                          browser-compatible but container isn't (TS,
 *                          MKV with H.264/AAC, etc.).
 *         'audio_only'   — `-c:v copy -c:a aac` fMP4. Use when video is
 *                          fine but audio is AC-3/EAC-3.
 *         'video_only'   — `-c:v <hwaccel> -c:a copy` fMP4. Rare case
 *                          where AAC is fine but video is HEVC and
 *                          browser can't decode.
 *         'full'         — re-encode both. Last resort, expensive.
 *       opts.seek (seconds) — restart at this offset for "seek without
 *       byte-range" via `-ss`. Default 0.
 *
 *   - getHwaccel()
 *       Returns the encoder name detected at startup. Mac → h264_videotoolbox.
 *       Linux + NVIDIA → h264_nvenc. Linux + Intel/AMD VAAPI → h264_vaapi.
 *       Fallback → libx264 (software).
 *
 * Why a dedicated service (vs adding to stream.js): the live-channel
 * pipeline is single-purpose — `-c copy -f mpegts pipe:1` with HTTP
 * reconnect knobs. VOD has four orthogonal modes and codec-driven
 * decisions; mixing them in stream.js would explode that file even
 * further. Keep the responsibilities apart.
 */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// ─── Hardware-accelerated H.264 encoder detection ──────────────────
//
// Runs once at startup. Order of preference:
//   1. videotoolbox (Apple Silicon / Intel Mac) — best perf/CPU ratio
//      on the dev host, real-time even at 4K.
//   2. nvenc (NVIDIA GPU) — 7th-gen NVENC on GTX 1660+ does multiple
//      1080p streams at ~1% CPU. Production sweet spot.
//   3. vaapi (Intel iGPU or AMD GPU on Linux) — solid on most cheap
//      Linux servers.
//   4. libx264 (software) — fallback, real-time-ish at 1080p on a
//      modern CPU but pegs cores.
let detectedHwaccel = null;
let detectedVideoEncoder = 'libx264';

function detectFfmpegCapabilities() {
  try {
    const hwResult = spawnSync(FFMPEG, ['-hide_banner', '-hwaccels'], { encoding: 'utf-8', timeout: 5000 });
    const hwOut = (hwResult.stdout || '') + (hwResult.stderr || '');
    const encResult = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf-8', timeout: 5000 });
    const encOut = (encResult.stdout || '') + (encResult.stderr || '');

    // Look at hwaccel list AND encoder availability — videotoolbox may
    // be listed under -hwaccels but if -enable-videotoolbox wasn't set
    // at compile time the encoder won't exist.
    if (hwOut.includes('videotoolbox') && encOut.includes('h264_videotoolbox')) {
      detectedHwaccel = 'videotoolbox';
      detectedVideoEncoder = 'h264_videotoolbox';
    } else if (encOut.includes('h264_nvenc')) {
      detectedHwaccel = 'cuda';
      detectedVideoEncoder = 'h264_nvenc';
    } else if (encOut.includes('h264_vaapi')) {
      detectedHwaccel = 'vaapi';
      detectedVideoEncoder = 'h264_vaapi';
    } else if (encOut.includes('h264_qsv')) {
      detectedHwaccel = 'qsv';
      detectedVideoEncoder = 'h264_qsv';
    } else {
      detectedHwaccel = null;
      detectedVideoEncoder = 'libx264';
    }
    logger.info(`[ffmpegService] detected hwaccel=${detectedHwaccel || 'none'} encoder=${detectedVideoEncoder}`);
  } catch (e) {
    logger.warn(`[ffmpegService] hwaccel detection failed: ${e.message}. Falling back to libx264.`);
    detectedHwaccel = null;
    detectedVideoEncoder = 'libx264';
  }
}
detectFfmpegCapabilities();

function getHwaccel() {
  return { hwaccel: detectedHwaccel, encoder: detectedVideoEncoder };
}

// ─── Probe cache ───────────────────────────────────────────────────
//
// Postgres-backed because the same upstream URL might be requested by
// dozens of users (movies are deduplicated across accounts) and we
// don't want to re-probe per session. Same TTL story as the rest of
// the VOD data — codecs don't change unless the provider re-encodes,
// so cache forever and let manual invalidation handle the edge case.

const PROBE_CACHE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS vod_probe_cache (
    url_hash text PRIMARY KEY,
    container text,
    vcodec text,
    acodec text,
    width int,
    height int,
    duration_s numeric,
    vbitrate int,
    abitrate int,
    probed_at timestamptz NOT NULL DEFAULT now()
  )
`;

async function ensureProbeCacheTable() {
  try {
    await postgresService.query(PROBE_CACHE_TABLE_SQL);
  } catch (e) {
    logger.error(`[ffmpegService] ensureProbeCacheTable failed: ${e.message}`);
  }
}
ensureProbeCacheTable();

function hashUrl(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex');
}

async function getCachedProbe(url) {
  try {
    const r = await postgresService.query(
      'SELECT container, vcodec, acodec, width, height, duration_s, vbitrate, abitrate FROM vod_probe_cache WHERE url_hash = $1',
      [hashUrl(url)]
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function setCachedProbe(url, probe) {
  try {
    await postgresService.query(
      `INSERT INTO vod_probe_cache (url_hash, container, vcodec, acodec, width, height, duration_s, vbitrate, abitrate, probed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (url_hash) DO UPDATE SET
         container = EXCLUDED.container,
         vcodec = EXCLUDED.vcodec,
         acodec = EXCLUDED.acodec,
         width = EXCLUDED.width,
         height = EXCLUDED.height,
         duration_s = EXCLUDED.duration_s,
         vbitrate = EXCLUDED.vbitrate,
         abitrate = EXCLUDED.abitrate,
         probed_at = NOW()`,
      [
        hashUrl(url),
        probe.container || null,
        probe.vcodec || null,
        probe.acodec || null,
        probe.width || null,
        probe.height || null,
        probe.duration_s || null,
        probe.vbitrate || null,
        probe.abitrate || null
      ]
    );
  } catch (e) {
    logger.warn(`[ffmpegService] setCachedProbe failed: ${e.message}`);
  }
}

/**
 * Run ffprobe against an HTTP URL and parse the JSON output.
 *
 * Probesize/analyzeduration tuning: Jellyfin's pattern of 1G/200M is
 * the cause of their open HLS-timeout regression — that much input
 * means ffprobe waits seconds to minutes on slow links. We use 2M/4s
 * which is enough to read the moov box for MP4 and the first PMTs for
 * TS. Files where this misses (e.g. moov-at-end on a huge mp4) fall
 * back to whatever the container_extension column says.
 */
async function runFfprobe(url, headers = {}) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-probesize', '2000000',
      '-analyzeduration', '4000000',
      '-user_agent', headers['User-Agent'] || 'VLC/3.0.20 LibVLC/3.0.20',
    ];
    const extraHeaders = Object.entries(headers)
      .filter(([k]) => k.toLowerCase() !== 'user-agent')
      .map(([k, v]) => `${k}: ${v}`);
    if (extraHeaders.length) {
      args.push('-headers', extraHeaders.join('\r\n') + '\r\n');
    }
    args.push(
      '-show_format',
      '-show_streams',
      '-of', 'json',
      url
    );

    const proc = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    // Hard timeout — the small probesize already constrains how long
    // ffprobe should reasonably run, but slow upstreams can wedge.
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, 15000);

    proc.on('exit', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 || !stdout) {
        return resolve({ ok: false, error: stderr.slice(0, 500) || `ffprobe exited ${code}` });
      }
      try {
        const json = JSON.parse(stdout);
        const fmt = json.format || {};
        const streams = Array.isArray(json.streams) ? json.streams : [];
        const v = streams.find((s) => s.codec_type === 'video');
        const a = streams.find((s) => s.codec_type === 'audio');
        resolve({
          ok: true,
          probe: {
            container: (fmt.format_name || '').split(',')[0] || null,
            vcodec: v?.codec_name || null,
            acodec: a?.codec_name || null,
            width: v?.width || null,
            height: v?.height || null,
            duration_s: Number.isFinite(parseFloat(fmt.duration)) ? parseFloat(fmt.duration) : null,
            vbitrate: parseInt(v?.bit_rate, 10) || null,
            abitrate: parseInt(a?.bit_rate, 10) || null
          }
        });
      } catch (e) {
        resolve({ ok: false, error: `ffprobe JSON parse failed: ${e.message}` });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ ok: false, error: `ffprobe spawn failed: ${err.message}` });
    });
  });
}

/**
 * Cached probe. Hits the DB first, falls back to a live ffprobe and
 * persists the result.
 */
async function probeStream(url, headers = {}) {
  const cached = await getCachedProbe(url);
  if (cached) {
    return { ok: true, probe: cached, cached: true };
  }
  const r = await runFfprobe(url, headers);
  if (r.ok) {
    await setCachedProbe(url, r.probe);
    return { ok: true, probe: r.probe, cached: false };
  }
  return r;
}

// ─── Pipeline modes ────────────────────────────────────────────────
//
// All modes output fragmented MP4 to stdout. Browser plays via plain
// <video src=...> — native byte-range, native seek, no MSE plumbing.
// Seek without byte-range: the route handler kills + respawns with
// `-ss <newOffset>` and the browser sees a fresh content stream.

const FRAG_MP4_MUX_FLAGS = [
  '-f', 'mp4',
  // empty_moov         — header carries no track samples; samples ride
  //                      in moof+mdat fragments after.
  // frag_keyframe      — emit a new fragment at every keyframe so the
  //                      browser can start playback as soon as the
  //                      first GOP lands.
  // default_base_moof  — required for the in-band seek path used by
  //                      modern hls.js/Plex/Jellyfin players.
  // omit_tfhd_offset   — without this, fragments can carry conflicting
  //                      base offsets and Chrome rejects them.
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset'
];

function buildPipelineArgs(url, headers, mode, opts = {}) {
  const seek = Number(opts.seek) || 0;
  // Output height for the forced-quality path. When set, every mode
  // is forced into video re-encode with `-vf scale=-2:H` (the -2
  // keeps width divisible by 2 — required for H.264). `copy` and
  // `audio_only` modes can't honor this since they pass video through
  // unchanged, so we coerce mode→video_only/full when height is set.
  const targetHeight = Number(opts.height) || 0;
  if (targetHeight > 0) {
    if (mode === 'copy') mode = 'video_only';
    else if (mode === 'audio_only') mode = 'full';
  }
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-user_agent', headers['User-Agent'] || 'VLC/3.0.20 LibVLC/3.0.20'
  ];
  const extraHeaders = Object.entries(headers)
    .filter(([k]) => k.toLowerCase() !== 'user-agent')
    .map(([k, v]) => `${k}: ${v}`);
  if (extraHeaders.length) {
    args.push('-headers', extraHeaders.join('\r\n') + '\r\n');
  }
  // HTTP reconnect for transient blips during the body fetch. We do
  // NOT pass `-reconnect_at_eof` here (that's a live-stream flag) —
  // VOD has a finite Content-Length so EOF means the movie is over,
  // and reconnecting would loop forever re-fetching past the end.
  args.push(
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_on_http_error', '4xx,5xx',
    '-reconnect_delay_max', '8',
    '-reconnect_max_retries', '4',
    '-rw_timeout', '8000000'
  );
  // -ss before -i is the fast variant (seeks via container index).
  // For VOD we want the fast version even if it's slightly less
  // frame-accurate.
  if (seek > 0) {
    args.push('-ss', String(seek));
  }
  args.push(
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-i', url
  );

  switch (mode) {
    case 'copy':
      // Bitstream filters: TS containers carry AAC with ADTS headers
      // and H.264 in annex-b format. MP4 requires raw AAC frames
      // ("ASC") and length-prefixed NALU ("avcC"). The h264_mp4toannexb
      // filter is auto-applied by the MP4 muxer for H.264, but
      // aac_adtstoasc must be requested explicitly. Without it ffmpeg
      // dies with "Malformed AAC bitstream detected" the moment it
      // sees the first audio packet — exact symptom of the first TS
      // file we tested.
      args.push(
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc'
      );
      break;
    case 'audio_only':
      args.push(
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '192k'
      );
      break;
    case 'video_only':
      if (targetHeight > 0) {
        args.push('-vf', `scale=-2:${targetHeight}`);
      }
      args.push(
        '-c:v', detectedVideoEncoder,
        ...encoderTuning(detectedVideoEncoder),
        '-c:a', 'copy',
        '-bsf:a', 'aac_adtstoasc'
      );
      break;
    case 'full':
    default:
      if (targetHeight > 0) {
        args.push('-vf', `scale=-2:${targetHeight}`);
      }
      args.push(
        '-c:v', detectedVideoEncoder,
        ...encoderTuning(detectedVideoEncoder),
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '192k'
      );
      break;
  }

  args.push(...FRAG_MP4_MUX_FLAGS);
  args.push('pipe:1');
  return args;
}

function encoderTuning(encoder) {
  switch (encoder) {
    case 'h264_videotoolbox':
      // -allow_sw 1 lets it fall back to software path if hardware is
      // saturated. -realtime 1 keeps latency tight for VOD startup.
      return ['-b:v', '5M', '-realtime', '1', '-allow_sw', '1'];
    case 'h264_nvenc':
      return ['-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-b:v', '5M'];
    case 'h264_vaapi':
      return ['-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload', '-b:v', '5M'];
    case 'h264_qsv':
      return ['-preset', 'veryfast', '-b:v', '5M'];
    default:
      // libx264 software path. veryfast is the fastest preset that
      // still gives reasonable quality; ultrafast is grainy.
      return ['-preset', 'veryfast', '-crf', '23'];
  }
}

/**
 * Spawn the pipeline and return the child process. Caller wires
 * stdout into the HTTP response and listens for exit to clean up.
 */
function spawnPipeline(url, headers, mode, opts = {}) {
  const args = buildPipelineArgs(url, headers, mode, opts);
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return proc;
}

// ─── Decision helper ───────────────────────────────────────────────
//
// Given a probe result and the browser's capability map, decide which
// playback path to use. Returns one of:
//   - { mode: 'direct',     reason: '...' }    → serve raw bytes
//   - { mode: 'copy',       reason: '...' }    → transmux only
//   - { mode: 'audio_only', reason: '...' }    → re-encode audio
//   - { mode: 'video_only', reason: '...' }    → re-encode video
//   - { mode: 'full',       reason: '...' }    → re-encode both
//
// `caps` shape (from frontend):
//   { canH264, canHevc, canAac, canAc3, canEac3, canMkv }

function pickPlaybackMode(probe, caps, containerExt) {
  if (!probe || !probe.vcodec) {
    // No probe data — fall back to extension. .mp4/.mkv stay native;
    // everything else gets transmuxed defensively.
    const ext = String(containerExt || '').toLowerCase();
    if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') {
      return { mode: 'direct', reason: 'no probe; container looks native' };
    }
    if (ext === 'mkv' && (!caps || caps.canMkv !== false)) {
      return { mode: 'direct', reason: 'no probe; mkv with capable browser' };
    }
    return { mode: 'copy', reason: `no probe; container .${ext} not natively played, attempting transmux` };
  }

  const vc = String(probe.vcodec || '').toLowerCase();
  const ac = String(probe.acodec || '').toLowerCase();
  const cont = String(probe.container || '').toLowerCase();

  const vOk = (vc === 'h264' && caps?.canH264 !== false) || (vc === 'hevc' && caps?.canHevc === true);
  const aOk = (ac === 'aac' && caps?.canAac !== false) || (ac === 'mp3' && caps?.canAac !== false);

  // Pure direct play: container is mp4/mov, video + audio both native.
  if (vOk && aOk && (cont.includes('mp4') || cont === 'mov' || cont === 'm4v')) {
    return { mode: 'direct', reason: `mp4/${vc}/${ac} — direct` };
  }

  // Browser can decode video + audio but the container isn't browser-friendly
  // (TS, MKV-on-conservative-browser, etc.). Just transmux.
  if (vOk && aOk) {
    return { mode: 'copy', reason: `${vc}/${ac} OK, repackaging from ${cont || 'unknown'} into fMP4` };
  }

  // Video fine, audio needs work (AC-3 / EAC-3 the common case).
  if (vOk && !aOk) {
    return { mode: 'audio_only', reason: `${vc} OK, transcoding audio from ${ac}` };
  }

  // Audio fine, video needs work (rare, but possible for HEVC+AAC mp4).
  if (!vOk && aOk) {
    return { mode: 'video_only', reason: `${ac} OK, transcoding video from ${vc}` };
  }

  // Worst case: both need re-encoding.
  return { mode: 'full', reason: `transcoding both video (${vc}) and audio (${ac})` };
}

module.exports = {
  getHwaccel,
  probeStream,
  spawnPipeline,
  pickPlaybackMode,
  // exposed for tests
  buildPipelineArgs
};
