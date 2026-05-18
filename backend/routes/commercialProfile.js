/**
 * Commercial Profile Routes
 *
 * Per-user, per-channel learned profile that drives the commercial
 * auto-skip detector. Stores calibration (logo ROI + dHash, audio
 * thresholds) plus running counters for false-positive learning.
 *
 *   GET    /api/commercial-profile                 → all profiles for the user
 *   PUT    /api/commercial-profile/:channelId      → upsert profile fields
 *   POST   /api/commercial-profile/:channelId/detection      → bump counters
 *   POST   /api/commercial-profile/:channelId/false-positive → bump counters + relax thresholds + start ignore window
 *
 * The PUT is meant for auto-calibration ("we just learned this
 * channel's logo lives top-right with dHash X"). The two POSTs are
 * the learning signal — they nudge thresholds based on what just
 * happened on the user's screen.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const postgresService = require('../services/postgresService');

router.use(authMiddleware);

const SELECT_PROFILE = `
  SELECT
    channel_id        AS "channelId",
    channel_name      AS "channelName",
    logo_roi          AS "logoRoi",
    logo_dhash        AS "logoDhash",
    logo_hamming_threshold AS "logoHammingThreshold",
    silence_threshold AS "silenceThreshold",
    silence_dbfs      AS "silenceDbfs",
    loudness_delta_lu AS "loudnessDeltaLu",
    detection_count   AS "detectionCount",
    false_positive_count AS "falsePositiveCount",
    EXTRACT(EPOCH FROM last_detected_at) * 1000 AS "lastDetectedAt",
    EXTRACT(EPOCH FROM last_false_positive_at) * 1000 AS "lastFalsePositiveAt",
    EXTRACT(EPOCH FROM calibrated_at) * 1000 AS "calibratedAt",
    EXTRACT(EPOCH FROM ignore_until) * 1000 AS "ignoreUntil",
    EXTRACT(EPOCH FROM updated_at) * 1000 AS "updatedAt"
  FROM channel_commercial_profile
  WHERE user_id = $1
`;

router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const result = await postgresService.query(SELECT_PROFILE, [userId]);
    res.json({ success: true, profiles: result.rows });
  } catch (e) {
    logger.error('Get commercial profiles failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/:channelId', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const channelId = String(req.params.channelId || '').trim();
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const body = req.body || {};
    // Whitelist columns the client is allowed to set. The counters
    // and ignore_until are owned by the detection/FP endpoints; the
    // client never writes them directly.
    const cols = {
      channel_name:           body.channelName,
      logo_roi:               body.logoRoi ? JSON.stringify(body.logoRoi) : undefined,
      logo_dhash:             body.logoDhash,
      logo_hamming_threshold: body.logoHammingThreshold,
      silence_threshold:      body.silenceThreshold,
      silence_dbfs:           body.silenceDbfs,
      loudness_delta_lu:      body.loudnessDeltaLu
    };

    // Build a dynamic ON CONFLICT UPDATE that only touches keys the
    // client actually sent. Saves needing N flavors of upsert SQL.
    const insertCols = ['user_id', 'channel_id'];
    const insertVals = [userId, channelId];
    const placeholders = ['$1', '$2'];
    const updateAssigns = ['updated_at = CURRENT_TIMESTAMP'];

    let n = 2;
    for (const [col, val] of Object.entries(cols)) {
      if (val === undefined) continue;
      n += 1;
      insertCols.push(col);
      insertVals.push(val);
      placeholders.push(`$${n}`);
      updateAssigns.push(`${col} = EXCLUDED.${col}`);
    }

    // If the client sent logo_dhash or logo_roi, stamp calibrated_at.
    if (cols.logo_dhash !== undefined || cols.logo_roi !== undefined) {
      updateAssigns.push('calibrated_at = CURRENT_TIMESTAMP');
    }

    const sql = `
      INSERT INTO channel_commercial_profile (${insertCols.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (user_id, channel_id) DO UPDATE SET ${updateAssigns.join(', ')}
      RETURNING channel_id
    `;
    await postgresService.query(sql, insertVals);

    const fetched = await postgresService.query(
      `${SELECT_PROFILE} AND channel_id = $2`,
      [userId, channelId]
    );
    res.json({ success: true, profile: fetched.rows[0] || null });
  } catch (e) {
    logger.error('Upsert commercial profile failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST .../:channelId/detection — fire when the detector decides a
// break started (or ended). We just bump counters and stamp the
// timestamp; this is informational only.
router.post('/:channelId/detection', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const channelId = String(req.params.channelId || '').trim();

    await postgresService.query(
      `INSERT INTO channel_commercial_profile (user_id, channel_id, detection_count, last_detected_at)
       VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET
         detection_count = channel_commercial_profile.detection_count + 1,
         last_detected_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, channelId]
    );
    res.json({ success: true });
  } catch (e) {
    logger.error('Log detection failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST .../:channelId/false-positive — the user said "that wasn't an
// ad" (via Undo or manual unmute within the FP-window). We bump
// counters, set a 60s ignore window so we don't immediately re-mute
// the same tile, and *relax* the thresholds that fired:
//   - if 'audio' fired      → raise silence_dbfs by 1 dB (less sensitive to quiet content)
//   - if 'logo' fired       → raise logo_hamming_threshold by 2 (looser logo match)
//   - if 'blackframe' fired → no global threshold to relax (handled in detector)
router.post('/:channelId/false-positive', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const channelId = String(req.params.channelId || '').trim();
    const signals = Array.isArray(req.body?.signals) ? req.body.signals : [];
    const ignoreSeconds = Math.max(15, Math.min(600, Number(req.body?.ignoreSeconds) || 60));

    // Build the threshold-relax SET clause based on which signals fired.
    const adjustments = [];
    if (signals.includes('audio')) {
      // Make audio less twitchy. dBFS is negative; raising means a
      // louder noise floor before we call something silent.
      adjustments.push('silence_dbfs = LEAST(silence_dbfs + 1.0, -30.0)');
      adjustments.push('loudness_delta_lu = LEAST(loudness_delta_lu + 0.5, 8.0)');
    }
    if (signals.includes('logo')) {
      // Make logo match looser so we don't flag transient bug fades.
      adjustments.push('logo_hamming_threshold = LEAST(logo_hamming_threshold + 2, 28)');
    }

    const setClause = [
      'false_positive_count = channel_commercial_profile.false_positive_count + 1',
      'last_false_positive_at = CURRENT_TIMESTAMP',
      `ignore_until = CURRENT_TIMESTAMP + INTERVAL '${ignoreSeconds} seconds'`,
      'updated_at = CURRENT_TIMESTAMP',
      ...adjustments
    ].join(', ');

    await postgresService.query(
      `INSERT INTO channel_commercial_profile (user_id, channel_id, false_positive_count, last_false_positive_at, ignore_until)
       VALUES ($1, $2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '${ignoreSeconds} seconds')
       ON CONFLICT (user_id, channel_id) DO UPDATE SET ${setClause}`,
      [userId, channelId]
    );

    const fetched = await postgresService.query(
      `${SELECT_PROFILE} AND channel_id = $2`,
      [userId, channelId]
    );
    logger.info(`User ${userId} flagged FP for ${channelId} (signals: ${signals.join(',')})`);
    res.json({ success: true, profile: fetched.rows[0] || null });
  } catch (e) {
    logger.error('Log false-positive failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Fingerprint hotlist routes ───────────────────────────────────
//
// Each row holds one confirmed commercial-break's worth of audio
// signatures (packed Uint32Array as BYTEA). Sent over the wire as
// base64. The detector loads them on tile-register, matches in-memory
// against live audio, and POSTs new ones at break_end.

// Per-user storage budgets. When a user exceeds these, the oldest
// rows are pruned and a warning is logged. The intent is to bound
// per-user data without surprising the user — the dashboard surfaces
// usage so they can see the trajectory.
const FP_MAX_ROWS_PER_USER = 5000;
const FP_MAX_BYTES_PER_USER = 50 * 1024 * 1024; // 50 MB
const FP_WARN_RATIO = 0.8;

// Compute current usage for a user and prune if necessary. Returns
// the post-prune usage stats so callers (e.g. POST) can attach them
// to the response.
async function ensureFingerprintBudget(userId) {
  const stats = await postgresService.query(
    `SELECT COUNT(*)::int AS rows, COALESCE(SUM(octet_length(fingerprint)), 0)::bigint AS bytes
     FROM commercial_fingerprint WHERE user_id = $1`,
    [userId]
  );
  let rows = stats.rows[0].rows || 0;
  let bytes = Number(stats.rows[0].bytes || 0);

  const overRows = rows > FP_MAX_ROWS_PER_USER;
  const overBytes = bytes > FP_MAX_BYTES_PER_USER;

  if (overRows || overBytes) {
    // Prune oldest entries until we're back under both limits.
    // Done in one DELETE using a CTE that picks the oldest N to drop.
    const targetRows = Math.floor(FP_MAX_ROWS_PER_USER * 0.85);
    const targetBytes = Math.floor(FP_MAX_BYTES_PER_USER * 0.85);
    // Drop oldest until under both targets. Estimate how many rows to
    // drop based on the ratio of overshoot; bytes is the harder
    // constraint so we lean on that.
    const dropByBytes = overBytes
      ? Math.ceil(((bytes - targetBytes) / Math.max(1, bytes)) * rows)
      : 0;
    const dropByRows = overRows ? (rows - targetRows) : 0;
    const dropN = Math.max(dropByBytes, dropByRows, 50);

    const deleted = await postgresService.query(
      `DELETE FROM commercial_fingerprint
       WHERE id IN (
         SELECT id FROM commercial_fingerprint
         WHERE user_id = $1
         ORDER BY captured_at ASC
         LIMIT $2
       )
       RETURNING octet_length(fingerprint) AS bytes`,
      [userId, dropN]
    );
    const droppedBytes = deleted.rows.reduce((s, r) => s + Number(r.bytes || 0), 0);
    rows -= deleted.rowCount;
    bytes -= droppedBytes;
    logger.warn(
      `[commercial-fingerprint] PRUNED user=${userId} dropped=${deleted.rowCount} rows ` +
      `(${(droppedBytes / 1024).toFixed(1)} KB). New usage: ${rows} rows / ${(bytes / 1024 / 1024).toFixed(2)} MB.`
    );
  } else if (rows >= FP_MAX_ROWS_PER_USER * FP_WARN_RATIO || bytes >= FP_MAX_BYTES_PER_USER * FP_WARN_RATIO) {
    logger.warn(
      `[commercial-fingerprint] APPROACHING LIMIT user=${userId} ` +
      `${rows}/${FP_MAX_ROWS_PER_USER} rows (${(rows / FP_MAX_ROWS_PER_USER * 100).toFixed(0)}%), ` +
      `${(bytes / 1024 / 1024).toFixed(2)}/${FP_MAX_BYTES_PER_USER / 1024 / 1024} MB ` +
      `(${(bytes / FP_MAX_BYTES_PER_USER * 100).toFixed(0)}%)`
    );
  }

  return {
    rows,
    bytes,
    maxRows: FP_MAX_ROWS_PER_USER,
    maxBytes: FP_MAX_BYTES_PER_USER,
    rowsRatio: rows / FP_MAX_ROWS_PER_USER,
    bytesRatio: bytes / FP_MAX_BYTES_PER_USER
  };
}

// GET /api/commercial-profile/fingerprints/stats — usage summary for
// the dashboard.
router.get('/fingerprints/stats', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const overall = await postgresService.query(
      `SELECT COUNT(*)::int AS rows,
              COALESCE(SUM(octet_length(fingerprint)), 0)::bigint AS bytes,
              COUNT(DISTINCT channel_id)::int AS channels,
              EXTRACT(EPOCH FROM MIN(captured_at)) * 1000 AS oldest_at,
              EXTRACT(EPOCH FROM MAX(captured_at)) * 1000 AS newest_at
       FROM commercial_fingerprint WHERE user_id = $1`,
      [userId]
    );
    const byChannel = await postgresService.query(
      `SELECT channel_id,
              COUNT(*)::int AS rows,
              COALESCE(SUM(octet_length(fingerprint)), 0)::bigint AS bytes,
              EXTRACT(EPOCH FROM MAX(captured_at)) * 1000 AS newest_at
       FROM commercial_fingerprint
       WHERE user_id = $1
       GROUP BY channel_id
       ORDER BY rows DESC
       LIMIT 50`,
      [userId]
    );

    const r = overall.rows[0];
    res.json({
      success: true,
      stats: {
        rows: r.rows || 0,
        bytes: Number(r.bytes || 0),
        channels: r.channels || 0,
        oldestAt: r.oldest_at ? Number(r.oldest_at) : null,
        newestAt: r.newest_at ? Number(r.newest_at) : null,
        maxRows: FP_MAX_ROWS_PER_USER,
        maxBytes: FP_MAX_BYTES_PER_USER,
        rowsRatio: (r.rows || 0) / FP_MAX_ROWS_PER_USER,
        bytesRatio: Number(r.bytes || 0) / FP_MAX_BYTES_PER_USER,
        warnRatio: FP_WARN_RATIO,
        byChannel: byChannel.rows.map((row) => ({
          channelId: row.channel_id,
          rows: row.rows,
          bytes: Number(row.bytes || 0),
          newestAt: row.newest_at ? Number(row.newest_at) : null
        }))
      }
    });
  } catch (e) {
    logger.error('Get fingerprint stats failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/commercial-profile/fingerprints/:channelId — load hotlist
// for a single channel. The detector calls this on tile-register and
// keeps the result in memory for fast per-tick matching.
router.get('/fingerprints/:channelId', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const channelId = String(req.params.channelId || '').trim();
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const result = await postgresService.query(
      `SELECT id, fingerprint, duration_ms AS "durationMs",
              EXTRACT(EPOCH FROM captured_at) * 1000 AS "capturedAt"
       FROM commercial_fingerprint
       WHERE user_id = $1 AND channel_id = $2
       ORDER BY captured_at DESC`,
      [userId, channelId]
    );

    // Encode each fingerprint as base64 — the BYTEA comes back as a
    // Buffer; the client will decode it back into a Uint32Array.
    res.json({
      success: true,
      fingerprints: result.rows.map((row) => ({
        id: row.id,
        fingerprint: Buffer.from(row.fingerprint).toString('base64'),
        durationMs: row.durationMs,
        capturedAt: Number(row.capturedAt)
      }))
    });
  } catch (e) {
    logger.error('Load fingerprints failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/commercial-profile/fingerprints/:channelId — save a new
// captured fingerprint. Triggers the per-user budget check + prune.
router.post('/fingerprints/:channelId', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const channelId = String(req.params.channelId || '').trim();
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const fpBase64 = req.body?.fingerprint;
    const durationMs = Number(req.body?.durationMs || 0);
    if (typeof fpBase64 !== 'string' || fpBase64.length === 0) {
      return res.status(400).json({ error: 'fingerprint (base64) required' });
    }

    const fpBuf = Buffer.from(fpBase64, 'base64');
    if (fpBuf.length === 0 || fpBuf.length % 4 !== 0) {
      return res.status(400).json({ error: 'fingerprint must be a multiple of 4 bytes' });
    }
    // Sanity-cap a single insert at 1 MB to avoid runaway storage on
    // a single malformed call.
    if (fpBuf.length > 1024 * 1024) {
      return res.status(413).json({ error: 'fingerprint too large' });
    }

    const inserted = await postgresService.query(
      `INSERT INTO commercial_fingerprint (user_id, channel_id, fingerprint, duration_ms)
       VALUES ($1, $2, $3, $4)
       RETURNING id, EXTRACT(EPOCH FROM captured_at) * 1000 AS "capturedAt"`,
      [userId, channelId, fpBuf, Math.max(0, Math.min(600_000, durationMs))]
    );

    logger.info(
      `[commercial-fingerprint] STORED user=${userId} channel=${channelId} ` +
      `${fpBuf.length} bytes / ${durationMs}ms`
    );

    const usage = await ensureFingerprintBudget(userId);

    res.json({
      success: true,
      fingerprint: {
        id: inserted.rows[0].id,
        capturedAt: Number(inserted.rows[0].capturedAt),
        durationMs
      },
      usage
    });
  } catch (e) {
    logger.error('Save fingerprint failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/commercial-profile/fingerprints/:channelId/latest —
// remove the most-recently-captured fingerprint for a channel. Called
// by the orchestrator when the user clicks Undo on the AD chip — we
// just learned the wrong thing.
router.delete('/fingerprints/:channelId/latest', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const channelId = String(req.params.channelId || '').trim();
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const result = await postgresService.query(
      `DELETE FROM commercial_fingerprint
       WHERE id = (
         SELECT id FROM commercial_fingerprint
         WHERE user_id = $1 AND channel_id = $2
         ORDER BY captured_at DESC
         LIMIT 1
       )
       RETURNING id`,
      [userId, channelId]
    );
    if (result.rowCount > 0) {
      logger.info(`[commercial-fingerprint] UNLEARNED user=${userId} channel=${channelId} id=${result.rows[0].id}`);
    }
    res.json({ success: true, deleted: result.rowCount });
  } catch (e) {
    logger.error('Delete latest fingerprint failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
