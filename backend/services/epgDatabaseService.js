/**
 * EPG Database Service - PostgreSQL Implementation
 * Replaces MongoDB-based epgDatabaseService.js
 * Uses COPY for 10-100x faster bulk inserts
 */

const logger = require('../config/logger');
const { pool } = require('./postgresService');
const copyFrom = require('pg-copy-streams').from;
const { Readable } = require('stream');

// ============================================================================
// epg_programs partition lifecycle (post-migration 034)
//
// After migration 034 epg_programs is LIST-partitioned by source_id. Each
// EPG source needs its own partition table (epg_programs_p_<source_id>)
// provisioned before any row can land in it; otherwise rows fall into the
// DEFAULT partition and the per-source TRUNCATE optimisation can't apply.
//
// Both helpers are no-ops on databases that haven't run migration 034 yet
// (epg_programs is still a regular table → CREATE TABLE PARTITION OF
// would error). The guard checks pg_class.relkind = 'p'.
// ============================================================================

const PARTITION_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;

async function isProgramsPartitioned() {
  const r = await pool.query(
    `SELECT 1 FROM pg_class WHERE relname = 'epg_programs' AND relkind = 'p'`
  );
  return r.rows.length > 0;
}

async function ensureProgramsPartition(sourceId) {
  if (!sourceId || typeof sourceId !== 'string') return null;
  if (!PARTITION_KEY_RE.test(sourceId)) {
    logger.warn(`[ensureProgramsPartition] sourceId "${sourceId}" fails identifier safety check; falling through to DEFAULT partition`);
    return null;
  }
  if (!(await isProgramsPartitioned())) return null;
  const partitionName = `epg_programs_p_${sourceId}`;
  const exists = await pool.query(
    `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
    [partitionName]
  );
  if (exists.rows.length > 0) return partitionName;
  // sourceId is hex-safe per regex above; LIST partition values can't
  // be supplied as bind parameters so direct interpolation is the
  // documented pattern (see migration 034 step 5).
  await pool.query(
    `CREATE TABLE "${partitionName}" PARTITION OF epg_programs FOR VALUES IN ('${sourceId}')`
  );
  logger.info(`[epg] created partition ${partitionName} for source ${sourceId}`);
  return partitionName;
}

async function dropProgramsPartition(sourceId) {
  if (!sourceId || typeof sourceId !== 'string') return;
  if (!PARTITION_KEY_RE.test(sourceId)) return;
  if (!(await isProgramsPartitioned())) return;
  const partitionName = `epg_programs_p_${sourceId}`;
  await pool.query(`DROP TABLE IF EXISTS "${partitionName}"`);
}

const epgDatabaseService = {
  /**
   * Initialize database connection (no-op for PostgreSQL, pool already initialized)
   */
  async init() {
    logger.info('PostgreSQL EPG service initialized (using shared pool)');
  },

  // Expose lifecycle helpers so the parser service + tests can drive them.
  ensureProgramsPartition,
  dropProgramsPartition,
  isProgramsPartitioned,

  /**
   * Save EPG source data
   */
  async saveSource(source) {
    try {
      // owner_iptv_source_id (post-035): null for global public EPGs
      // (epg.pw, EPG Talk Guide, …), set for bundled EPGs that came
      // from a specific iptv_source's provider. We COALESCE on
      // UPSERT so a later save that doesn't pass an owner doesn't
      // accidentally null it out — once a row is marked as owned by
      // an iptv_source it stays that way until the owner is deleted
      // (CASCADE handles the cleanup).
      const query = `
        INSERT INTO epg_sources (id, name, url, file_path, channel_count, program_count, owner_iptv_source_id, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          url = EXCLUDED.url,
          file_path = EXCLUDED.file_path,
          channel_count = EXCLUDED.channel_count,
          program_count = EXCLUDED.program_count,
          owner_iptv_source_id = COALESCE(EXCLUDED.owner_iptv_source_id, epg_sources.owner_iptv_source_id),
          last_updated = CURRENT_TIMESTAMP
        RETURNING *
      `;

      const values = [
        source.id,
        source.name,
        source.url || null,
        source.filePath || null,
        source.channelCount || 0,
        source.programCount || 0,
        source.ownerIptvSourceId || null
      ];

      const result = await pool.query(query, values);
      const saved = result.rows[0];
      // Provision the epg_programs partition for this source so the
      // first parse run can TRUNCATE+COPY into it directly rather
      // than landing rows in the DEFAULT partition. Safe no-op on
      // pre-034 databases (regular table) and on rerun for sources
      // whose partition already exists.
      try {
        await ensureProgramsPartition(saved.id);
      } catch (e) {
        logger.warn(`[saveSource] failed to provision partition for ${saved.id}: ${e.message}`);
      }
      return saved;
    } catch (error) {
      logger.error(`Error saving EPG source: ${error.message}`);
      throw error;
    }
  },

  /**
   * Save EPG channel data
   */
  async saveChannel(channel) {
    try {
      const query = `
        INSERT INTO epg_channels (id, source_id, name, icon, language_code, categories_csv, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          source_id = EXCLUDED.source_id,
          name = EXCLUDED.name,
          icon = EXCLUDED.icon,
          language_code = EXCLUDED.language_code,
          categories_csv = EXCLUDED.categories_csv,
          last_updated = CURRENT_TIMESTAMP
        RETURNING *
      `;

      const values = [
        channel.id,
        channel.sourceId,
        channel.name,
        channel.icon || null,
        channel.languageCode || null,
        channel.categoriesCSV || null
      ];

      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      logger.error(`Error saving EPG channel: ${error.message}`);
      throw error;
    }
  },

  /**
   * Save EPG program data
   */
  async saveProgram(program) {
    try {
      const query = `
        INSERT INTO epg_programs (id, channel_id, source_id, title, description, start_time, stop_time, categories, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          source_id = EXCLUDED.source_id,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          start_time = EXCLUDED.start_time,
          stop_time = EXCLUDED.stop_time,
          categories = EXCLUDED.categories,
          last_updated = CURRENT_TIMESTAMP
        RETURNING *
      `;

      const values = [
        program.id,
        program.channelId,
        program.sourceId,
        program.title,
        program.description || null,
        program.start,
        program.stop,
        program.categories || []
      ];

      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      logger.error(`Error saving EPG program: ${error.message}`);
      throw error;
    }
  },

  /**
   * Save multiple channels in bulk (ultra-fast COPY method)
   */
  async saveChannels(channels) {
    if (!channels || channels.length === 0) {
      return { acknowledged: true, modifiedCount: 0 };
    }

    const client = await pool.connect();

    try {
      // Use COPY for 10-100x faster bulk insert
      // First create temp table, COPY into it, then upsert to main table
      await client.query('BEGIN');

      // Create temporary table
      await client.query(`
        CREATE TEMP TABLE temp_epg_channels (LIKE epg_channels INCLUDING DEFAULTS)
        ON COMMIT DROP
      `);

      // Prepare CSV data for COPY
      const csvLines = channels.map(channel => {
        const values = [
          channel.id || '',
          channel.sourceId || '',
          channel.name || '',
          channel.icon || '',
          channel.languageCode || '',
          channel.categoriesCSV || ''
        ];
        // Escape values and create tab-separated line
        return values.map(v => String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n')).join('\t');
      });

      // Create readable stream from CSV data
      const stream = Readable.from(csvLines.join('\n'));

      // Use COPY to load data into temp table (super fast!)
      const copyStream = client.query(copyFrom(`
        COPY temp_epg_channels (id, source_id, name, icon, language_code, categories_csv)
        FROM STDIN
      `));

      // Pipe data to PostgreSQL with proper error handling
      await new Promise((resolve, reject) => {
        let finished = false;

        const cleanup = () => {
          try {
            stream.destroy();
          } catch (e) {
            // Ignore cleanup errors
          }
        };

        const onFinish = () => {
          if (!finished) {
            finished = true;
            resolve();
          }
        };

        const onError = (err) => {
          if (!finished) {
            finished = true;
            cleanup();
            reject(err);
          }
        };

        // Handle errors from both streams
        stream.on('error', onError);
        copyStream.on('error', onError);
        copyStream.on('finish', onFinish);

        // Pipe the data
        stream.pipe(copyStream);
      });

      // First, deduplicate the temp table itself (keep first occurrence based on ctid)
      // Using PostgreSQL-documented approach with CTE and window function
      await client.query(`
        WITH duplicates AS (
          SELECT ctid,
                 ROW_NUMBER() OVER (PARTITION BY id ORDER BY ctid) AS rn
          FROM temp_epg_channels
        )
        DELETE FROM temp_epg_channels
        WHERE ctid IN (
          SELECT ctid FROM duplicates WHERE rn > 1
        )
      `);

      // Now insert from deduplicated temp table to main table
      const result = await client.query(`
        INSERT INTO epg_channels (id, source_id, name, icon, language_code, categories_csv, last_updated)
        SELECT id, source_id, name, icon, language_code, categories_csv, CURRENT_TIMESTAMP
        FROM temp_epg_channels
        ON CONFLICT (id) DO UPDATE SET
          source_id = EXCLUDED.source_id,
          name = EXCLUDED.name,
          icon = EXCLUDED.icon,
          language_code = EXCLUDED.language_code,
          categories_csv = EXCLUDED.categories_csv,
          last_updated = CURRENT_TIMESTAMP
      `);

      await client.query('COMMIT');

      logger.info(`Bulk saved ${channels.length} EPG channels using COPY (ultra-fast)`);

      return {
        acknowledged: true,
        modifiedCount: result.rowCount,
        upsertedCount: result.rowCount
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error bulk saving EPG channels: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Save multiple programs in bulk (ultra-fast COPY method)
   */
  /**
   * Bulk-save EPG programs via COPY.
   *
   * Post-migration 034 (epg_programs partitioned by source_id), the
   * upstream parser flow is:
   *   1. epgParserService.parseEpgSource TRUNCATEs the source's
   *      partition (epg_programs_p_<source_id>) once at the start
   *   2. xmltvParser streams programs in 10k-row batches and calls
   *      savePrograms(batch) for each
   *
   * Because step 1 emptied the partition, step 2 has nothing to
   * conflict with — we can COPY straight into epg_programs (the
   * partition router places each row by its source_id) and skip the
   * temp-table + INSERT...ON CONFLICT round-trip entirely. That UPSERT
   * was the bottleneck: ~15-20s per 10k programs because every row
   * paid for a PK lookup + 7 index updates on the global table.
   *
   * For safety we keep the old path as a fallback on pre-034
   * databases where epg_programs is still a regular (non-partitioned)
   * table — the UPSERT is needed there because we can't TRUNCATE
   * per-source without DELETE-ing first.
   *
   * The streaming COPY format and category/description escaping are
   * lifted verbatim from the pre-034 implementation. Don't change the
   * Readable.from(...) → copyFrom pipeline without verifying it
   * survives the same edge cases (long descriptions, HTML in
   * categories, NULL channel_id, etc.).
   */
  async savePrograms(programs) {
    if (!programs || programs.length === 0) {
      return { acknowledged: true, modifiedCount: 0 };
    }

    const partitioned = await isProgramsPartitioned();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Always use a temp table — both pre-034 (target=global) and
      // post-034 (target=partition). The temp table absorbs intra-
      // source duplicate IDs (XMLTV feeds occasionally repeat a
      // programme tag across batches) and lets us INSERT...ON
      // CONFLICT DO NOTHING into the destination. Without it the
      // partition-direct COPY would abort the whole refresh on the
      // first cross-batch dupe — exactly what failed on Starlite
      // EPG (see backend logs 2026-05-22 16:29:51).
      //
      // CREATE TEMP TABLE on each call is ~5-10ms — negligible
      // compared to the 1-2s COPY itself. The temp drops on commit
      // so there's no accumulation.
      await client.query(`
        CREATE TEMP TABLE temp_epg_programs (LIKE epg_programs INCLUDING DEFAULTS)
        ON COMMIT DROP
      `);
      const copyTarget = 'temp_epg_programs';

      // Prepare CSV data for COPY - stream line-by-line to avoid
      // string length limits. Format columns must match the COPY
      // statement below.
      function* generateCSVLines() {
        for (const program of programs) {
          // Build PostgreSQL array - strip HTML and problematic
          // characters from categories.
          let categoriesValue = '{}';
          if (program.categories && program.categories.length > 0) {
            const cleanedCategories = program.categories.map(c => {
              return String(c)
                .replace(/<[^>]*>/g, '')  // Remove HTML tags
                .replace(/&[^;]+;/g, '')  // Remove HTML entities
                .trim();
            }).filter(c => c.length > 0);

            if (cleanedCategories.length > 0) {
              const escapedCats = cleanedCategories.map(c =>
                `"${c.replace(/\\/g, '\\\\\\\\').replace(/"/g, '\\\\"')}"`
              );
              categoriesValue = `{${escapedCats.join(',')}}`;
            }
          }

          const values = [
            program.id || '',
            program.channelId || '',
            program.sourceId || '',
            program.title || '',
            (program.description || '').substring(0, 10000),
            program.start ? new Date(program.start).toISOString() : '',
            program.stop ? new Date(program.stop).toISOString() : '',
            categoriesValue
          ];

          // Escape values for COPY format (but NOT categories — already escaped above).
          const escapedValues = values.map((v, idx) => {
            if (idx === 7) return v;
            return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
          });

          yield escapedValues.join('\t') + '\n';
        }
      }

      const stream = Readable.from(generateCSVLines());
      const copyStream = client.query(copyFrom(`
        COPY ${copyTarget} (id, channel_id, source_id, title, description, start_time, stop_time, categories)
        FROM STDIN
      `));

      await new Promise((resolve, reject) => {
        let finished = false;
        const cleanup = () => { try { stream.destroy(); } catch (e) {} };
        const onFinish = () => { if (!finished) { finished = true; resolve(); } };
        const onError = (err) => { if (!finished) { finished = true; cleanup(); reject(err); } };
        stream.on('error', onError);
        copyStream.on('error', onError);
        copyStream.on('finish', onFinish);
        stream.pipe(copyStream);
      });

      let modifiedCount;
      if (partitioned) {
        // Post-034: INSERT from temp into the partitioned parent.
        // Partition routing auto-places each row by source_id. The
        // ON CONFLICT target is the COMPOSITE PK (id, source_id) —
        // matches the partition's local PK created in migration 034.
        // DO NOTHING (vs DO UPDATE in the pre-034 fallback) — the
        // partition was TRUNCATEd at the start of the refresh, so
        // any conflict here is an intra-source duplicate that we
        // want to silently discard (NOT overwrite, which would be
        // wasted work). DISTINCT ON within the SELECT swallows
        // intra-batch dupes; ON CONFLICT handles the cross-batch
        // case.
        const result = await client.query(`
          INSERT INTO epg_programs (id, channel_id, source_id, title, description, start_time, stop_time, categories, last_updated)
          SELECT DISTINCT ON (id, source_id) id, channel_id, source_id, title, description, start_time, stop_time, categories, CURRENT_TIMESTAMP
          FROM temp_epg_programs
          ON CONFLICT (id, source_id) DO NOTHING
        `);
        modifiedCount = result.rowCount;
      } else {
        // Pre-034 fallback path — UPSERT from temp into the global
        // table, with DISTINCT ON to swallow intra-batch dupes.
        const result = await client.query(`
          INSERT INTO epg_programs (id, channel_id, source_id, title, description, start_time, stop_time, categories, last_updated)
          SELECT DISTINCT ON (id) id, channel_id, source_id, title, description, start_time, stop_time, categories, CURRENT_TIMESTAMP
          FROM temp_epg_programs
          ON CONFLICT (id) DO UPDATE SET
            channel_id = EXCLUDED.channel_id,
            source_id = EXCLUDED.source_id,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            start_time = EXCLUDED.start_time,
            stop_time = EXCLUDED.stop_time,
            categories = EXCLUDED.categories,
            last_updated = CURRENT_TIMESTAMP
        `);
        modifiedCount = result.rowCount;
      }

      await client.query('COMMIT');

      logger.info(
        `Bulk saved ${programs.length} EPG programs using COPY (${partitioned ? 'direct partition' : 'temp+upsert fallback'})`
      );

      return {
        acknowledged: true,
        modifiedCount,
        upsertedCount: modifiedCount
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error bulk saving EPG programs: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Get EPG sources
   */
  async getSources() {
    try {
      const query = 'SELECT * FROM epg_sources ORDER BY name';
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error(`Error getting EPG sources: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get EPG channels for a source
   */
  async getChannelsBySourceId(sourceId) {
    try {
      const query = 'SELECT * FROM epg_channels WHERE source_id = $1 ORDER BY name';
      const result = await pool.query(query, [sourceId]);
      return result.rows;
    } catch (error) {
      logger.error(`Error getting EPG channels for source ${sourceId}: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get all EPG channels
   */
  async getAllChannels() {
    try {
      const query = 'SELECT * FROM epg_channels ORDER BY name';
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error(`Error getting all EPG channels: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get EPG channel by ID
   */
  async getChannelById(channelId) {
    try {
      const query = `
        SELECT c.*, s.name as source_name
        FROM epg_channels c
        LEFT JOIN epg_sources s ON c.source_id = s.id
        WHERE c.id = $1
      `;

      const result = await pool.query(query, [channelId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        sourceId: row.source_id,
        name: row.name,
        icon: row.icon,
        source_name: row.source_name || 'Unknown Source'
      };
    } catch (error) {
      logger.error(`Error getting EPG channel by ID ${channelId}: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get programs for a channel within a time window
   */
  async getProgramsByChannelId(channelId, startTime, endTime) {
    try {
      // Default time window if not provided: next 24 hours
      const now = startTime || new Date();
      const tomorrow = endTime || new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const query = `
        SELECT id, channel_id, title, description, start_time, stop_time, categories
        FROM epg_programs
        WHERE channel_id = $1
          AND start_time <= $3
          AND stop_time >= $2
        ORDER BY start_time ASC
        LIMIT 100
      `;

      logger.info(`[EPG DB] getProgramsByChannelId called for ${channelId}`);
      logger.info(`[EPG DB] Querying PostgreSQL epg_programs table, time range: ${now.toISOString()} to ${tomorrow.toISOString()}`);
      const result = await pool.query(query, [channelId, now, tomorrow]);
      logger.info(`[EPG DB] PostgreSQL returned ${result.rows.length} programs for ${channelId}`);
      if (channelId.includes('FX') && result.rows.length > 0) {
        logger.info(`[EPG DB] FX programs from PostgreSQL: first=${result.rows[0]?.title} (${result.rows[0]?.start_time}), last=${result.rows[result.rows.length-1]?.title}`);
      }

      return result.rows.map(program => ({
        id: program.id,
        channelId: program.channel_id,
        title: program.title,
        description: program.description,
        start: program.start_time,
        stop: program.stop_time,
        categories: program.categories
      }));
    } catch (error) {
      logger.error(`Error getting programs for channel ${channelId}: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get total channel count
   */
  async getChannelCount() {
    try {
      const query = 'SELECT COUNT(*) as count FROM epg_channels';
      const result = await pool.query(query);
      return parseInt(result.rows[0].count);
    } catch (error) {
      logger.error(`Error getting channel count: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get total program count
   */
  async getProgramCount() {
    try {
      const query = 'SELECT COUNT(*) as count FROM epg_programs';
      const result = await pool.query(query);
      return parseInt(result.rows[0].count);
    } catch (error) {
      logger.error(`Error getting program count: ${error.message}`);
      throw error;
    }
  },

  /**
   * Search channels by query (optimized with pg_trgm)
   */
  async searchChannels(query) {
    try {
      const searchTerm = query.toLowerCase().trim();

      // Use trigram index for fast fuzzy search
      // First try exact prefix match (fastest), then fuzzy match
      const sql = `
        SELECT c.id, c.source_id, c.name, c.icon, s.name as source_name,
               CASE
                 WHEN LOWER(c.name) = $2 THEN 1
                 WHEN LOWER(c.name) LIKE $3 THEN 2
                 ELSE 3
               END as match_priority
        FROM epg_channels c
        LEFT JOIN epg_sources s ON c.source_id = s.id
        WHERE c.name % $2 OR LOWER(c.name) LIKE $1
        ORDER BY match_priority, c.name
        LIMIT 100
      `;

      const result = await pool.query(sql, [`%${searchTerm}%`, searchTerm, `${searchTerm}%`]);

      return result.rows.map(row => ({
        id: row.id,
        sourceId: row.source_id,
        name: row.name,
        icon: row.icon,
        source_name: row.source_name || 'Unknown Source'
      }));
    } catch (error) {
      logger.error(`Error searching EPG channels with query "${query}": ${error.message}`);
      throw error;
    }
  },

  /**
   * Get EPG statistics
   */
  async getStats() {
    try {
      const queries = [
        pool.query('SELECT COUNT(*) as count FROM epg_sources'),
        pool.query('SELECT COUNT(*) as count FROM epg_channels'),
        pool.query('SELECT COUNT(*) as count FROM epg_programs')
      ];

      const [sourcesResult, channelsResult, programsResult] = await Promise.all(queries);

      return {
        sources: parseInt(sourcesResult.rows[0].count),
        channels: parseInt(channelsResult.rows[0].count),
        programs: parseInt(programsResult.rows[0].count)
      };
    } catch (error) {
      logger.error(`Error getting EPG stats: ${error.message}`);
      throw error;
    }
  },

  /**
   * TRUNCATE all EPG data (fast, for full refresh)
   * This is 100x faster than DELETE for large datasets
   */
  async truncateAllEpgData() {
    try {
      logger.info('Truncating all EPG data...');

      // TRUNCATE is much faster than DELETE - it doesn't scan rows
      // CASCADE will also clear epg_programs since it has FK to epg_channels
      await pool.query('TRUNCATE TABLE epg_programs RESTART IDENTITY CASCADE');
      await pool.query('TRUNCATE TABLE epg_channels RESTART IDENTITY CASCADE');
      await pool.query('TRUNCATE TABLE epg_sources RESTART IDENTITY CASCADE');

      logger.info('All EPG data truncated successfully');
    } catch (error) {
      logger.error(`Error truncating EPG data: ${error.message}`);
      throw error;
    }
  },

  /**
   * Clear all EPG data for a source (slower, for single source refresh)
   */
  async clearSourceData(sourceId) {
    try {
      // Get counts first for the response
      const countQueries = [
        pool.query('SELECT COUNT(*) as count FROM epg_channels WHERE source_id = $1', [sourceId]),
        pool.query('SELECT COUNT(*) as count FROM epg_programs WHERE source_id = $1', [sourceId])
      ];

      const [channelsResult, programsResult] = await Promise.all(countQueries);
      const channelCount = parseInt(channelsResult.rows[0].count);
      const programCount = parseInt(programsResult.rows[0].count);

      // Delete ONLY channels and programs, KEEP the source for foreign key integrity
      await pool.query('DELETE FROM epg_programs WHERE source_id = $1', [sourceId]);
      await pool.query('DELETE FROM epg_channels WHERE source_id = $1', [sourceId]);

      return {
        deletedSource: sourceId,
        deletedChannels: channelCount,
        deletedPrograms: programCount
      };
    } catch (error) {
      logger.error(`Error clearing data for source ${sourceId}: ${error.message}`);
      throw error;
    }
  },

  /**
   * Clear all EPG data from database
   */
  async clearAllData() {
    try {
      // Delete in order: programs, channels, sources
      await pool.query('DELETE FROM epg_programs');
      await pool.query('DELETE FROM epg_channels');
      await pool.query('DELETE FROM epg_sources');

      return { success: true, message: 'All EPG data cleared' };
    } catch (error) {
      logger.error(`Error clearing all EPG data: ${error.message}`);
      throw error;
    }
  },

  /**
   * Optimize database for bulk loading
   */
  async optimizeForBulkLoad() {
    try {
      logger.info('Optimizing database for bulk load...');

      // Increase work_mem for better sort performance
      await pool.query('SET work_mem = \'256MB\'');

      // Increase maintenance_work_mem for index creation
      await pool.query('SET maintenance_work_mem = \'512MB\'');

      // Disable autovacuum during bulk load
      await pool.query('ALTER TABLE epg_channels SET (autovacuum_enabled = false)');
      await pool.query('ALTER TABLE epg_programs SET (autovacuum_enabled = false)');

      // Disable WAL for these tables (UNLOGGED) - WARNING: data loss on crash
      // await pool.query('ALTER TABLE epg_channels SET UNLOGGED');
      // await pool.query('ALTER TABLE epg_programs SET UNLOGGED');

      logger.info('Database optimized for bulk load');
    } catch (error) {
      logger.error(`Error optimizing for bulk load: ${error.message}`);
      // Don't throw - continue even if optimization fails
    }
  },

  /**
   * Restore database settings after bulk loading
   */
  async restoreAfterBulkLoad() {
    try {
      logger.info('Restoring database settings after bulk load...');

      // Re-enable autovacuum
      await pool.query('ALTER TABLE epg_channels SET (autovacuum_enabled = true)');
      await pool.query('ALTER TABLE epg_programs SET (autovacuum_enabled = true)');

      // Restore WAL if we disabled it
      // await pool.query('ALTER TABLE epg_channels SET LOGGED');
      // await pool.query('ALTER TABLE epg_programs SET LOGGED');

      // Run ANALYZE to update statistics
      await pool.query('ANALYZE epg_channels');
      await pool.query('ANALYZE epg_programs');

      logger.info('Database settings restored');
    } catch (error) {
      logger.error(`Error restoring database settings: ${error.message}`);
      // Don't throw - continue even if restoration fails
    }
  },

  /**
   * Drop indexes for bulk loading performance
   */
  async dropIndexes() {
    try {
      logger.info('Dropping EPG indexes for bulk load...');

      // Optimize database settings first
      await this.optimizeForBulkLoad();

      // Drop all non-primary key indexes
      const dropQueries = [
        // EPG Sources indexes
        'DROP INDEX IF EXISTS idx_epg_sources_name',

        // EPG Channels indexes
        'DROP INDEX IF EXISTS idx_epg_channels_source_id',
        'DROP INDEX IF EXISTS idx_epg_channels_name',
        'DROP INDEX IF EXISTS idx_epg_channels_name_lower',
        'DROP INDEX IF EXISTS idx_epg_channels_name_trgm',

        // EPG Programs indexes
        'DROP INDEX IF EXISTS idx_epg_programs_channel_id',
        'DROP INDEX IF EXISTS idx_epg_programs_source_id',
        'DROP INDEX IF EXISTS idx_epg_programs_time_range',
        'DROP INDEX IF EXISTS idx_epg_programs_start_time',
        'DROP INDEX IF EXISTS idx_epg_programs_stop_time',
        'DROP INDEX IF EXISTS idx_epg_programs_channel_time'
      ];

      for (const query of dropQueries) {
        await pool.query(query);
      }

      logger.info('EPG indexes dropped successfully');
    } catch (error) {
      logger.error(`Error dropping EPG indexes: ${error.message}`);
      throw error;
    }
  },

  /**
   * Recreate indexes after bulk loading
   */
  async recreateIndexes() {
    try {
      logger.info('Recreating EPG indexes...');

      // Recreate all indexes (same as in migration)
      const createQueries = [
        // EPG Sources
        'CREATE INDEX IF NOT EXISTS idx_epg_sources_name ON epg_sources(name)',

        // EPG Channels
        'CREATE INDEX IF NOT EXISTS idx_epg_channels_source_id ON epg_channels(source_id)',
        'CREATE INDEX IF NOT EXISTS idx_epg_channels_name ON epg_channels(name)',
        'CREATE INDEX IF NOT EXISTS idx_epg_channels_name_lower ON epg_channels(LOWER(name))',
        'CREATE INDEX IF NOT EXISTS idx_epg_channels_name_trgm ON epg_channels USING gin (name gin_trgm_ops)',

        // EPG Programs
        'CREATE INDEX IF NOT EXISTS idx_epg_programs_channel_id ON epg_programs(channel_id)',
        'CREATE INDEX IF NOT EXISTS idx_epg_programs_source_id ON epg_programs(source_id)',
        'CREATE INDEX IF NOT EXISTS idx_epg_programs_time_range ON epg_programs(channel_id, start_time, stop_time)',
        'CREATE INDEX IF NOT EXISTS idx_epg_programs_start_time ON epg_programs(start_time)',
        'CREATE INDEX IF NOT EXISTS idx_epg_programs_stop_time ON epg_programs(stop_time)',
        'CREATE INDEX IF NOT EXISTS idx_epg_programs_channel_time ON epg_programs(channel_id, start_time DESC, stop_time DESC)'
      ];

      for (const query of createQueries) {
        await pool.query(query);
      }

      // Analyze tables for query optimization (done in restoreAfterBulkLoad)
      logger.info('EPG indexes recreated successfully');

      // Restore database settings after bulk load
      await this.restoreAfterBulkLoad();
    } catch (error) {
      logger.error(`Error recreating EPG indexes: ${error.message}`);
      throw error;
    }
  },

  /**
   * Update source statistics
   */
  async updateSourceStats(sourceId, channelCount, programCount) {
    try {
      const query = `
        UPDATE epg_sources
        SET channel_count = $1,
            program_count = $2,
            last_updated = CURRENT_TIMESTAMP
        WHERE id = $3
      `;

      await pool.query(query, [channelCount, programCount, sourceId]);

      logger.info(`Updated source ${sourceId} stats: ${channelCount} channels, ${programCount} programs`);
    } catch (error) {
      logger.error(`Error updating source stats: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get all channel IDs for a source (as a Set for fast lookup)
   */
  async getChannelIdsBySource(sourceId) {
    try {
      const result = await pool.query(
        'SELECT id FROM epg_channels WHERE source_id = $1',
        [sourceId]
      );
      return new Set(result.rows.map(row => row.id));
    } catch (error) {
      logger.error(`Error getting channel IDs: ${error.message}`);
      throw error;
    }
  }
};

module.exports = epgDatabaseService;
