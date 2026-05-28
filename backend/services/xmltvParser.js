/**
 * XMLTV Streaming Parser - PostgreSQL Implementation
 * Replaces Python epg_parser.py with Node.js SAX-based streaming
 * Uses two-pass strategy for optimal performance with large files
 */

const sax = require('sax');
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream');
const logger = require('../config/logger');

const BATCH_SIZE = 5000; // Insert channels every 5000 for speed
const PROGRESS_INTERVAL_MS = 2000; // Report every 2 seconds

/**
 * Parse XMLTV file in SINGLE PASS - Parse channels AND programs together
 * SAX event handlers CANNOT be async, so we collect everything then insert at end
 *
 * @param {string} filePath - Path to XMLTV file (may be gzipped)
 * @param {string} sourceId - EPG source ID
 * @param {Function} onProgress - Optional progress callback
 * @param {Object} dbService - Database service for batched inserts
 * @returns {Promise<Object>} Object with channelCount and programCount
 */
async function parseSinglePass(filePath, sourceId, onProgress = null, dbService = null) {
  return new Promise((resolve, reject) => {
    const channels = [];
    const programBuffer = [];
    let currentChannel = null;
    let currentProgram = null;
    let currentElement = '';
    let lastProgressTime = Date.now();
    let skippedProgramCount = 0;
    let totalProgramsInserted = 0;
    let channelsInserted = false; // Track if we've inserted channels yet

    // Async queue for program insertions
    let activeInsertions = 0;
    const MAX_CONCURRENT_INSERTS = 3;
    const insertionPromises = [];

    // Circuit breaker for SAX errors (see parseSinglePassStreaming
    // for rationale — same protection against malformed input that
    // would otherwise spin the parser forever).
    let saxErrorCount = 0;
    const MAX_SAX_ERRORS = 1000;
    let aborted = false;

    // Create SAX parser (strict mode)
    const parser = sax.createStream(true, {
      trim: true,
      normalize: true,
      lowercase: true
    });

    // Handle opening tags
    parser.on('opentag', (node) => {
      currentElement = node.name;

      if (node.name === 'channel') {
        currentChannel = {
          id: node.attributes.id || '',
          sourceId: sourceId,
          name: '',
          icon: '',
          languageCode: null,
          categoriesCSV: null
        };
      } else if (currentChannel && node.name === 'icon' && node.attributes.src) {
        currentChannel.icon = node.attributes.src;
      } else if (node.name === 'programme') {
        currentProgram = {
          id: '',
          channelId: node.attributes.channel || '',
          sourceId: sourceId,
          title: '',
          description: null,
          start: parseXMLTVTimestamp(node.attributes.start),
          stop: parseXMLTVTimestamp(node.attributes.stop),
          categories: []
        };
      }
    });

    // Handle text content
    parser.on('text', (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (currentChannel && currentElement === 'display-name') {
        if (!currentChannel.name) {
          currentChannel.name = trimmed;
        }
      } else if (currentProgram) {
        switch (currentElement) {
          case 'title':
            currentProgram.title = trimmed;
            break;
          case 'desc':
            currentProgram.description = trimmed;
            break;
          case 'category':
            currentProgram.categories.push(trimmed);
            break;
        }
      }
    });

    // Handle closing tags - MUST BE SYNCHRONOUS
    parser.on('closetag', async (tagName) => {
      if (tagName === 'channel' && currentChannel) {
        if (currentChannel.id && currentChannel.name) {
          channels.push(currentChannel);

          // DO NOT insert channels during parsing - wait until end to deduplicate and insert ALL channels first
          // This prevents foreign key violations when programs reference channels that aren't in the DB yet

          // Progress every 1000 channels OR every 2 seconds
          const now = Date.now();
          const shouldReport = (channels.length % 1000 === 0) || (now - lastProgressTime >= PROGRESS_INTERVAL_MS);
          if (shouldReport) {
            const totalParsed = totalProgramsInserted + programBuffer.length;
            const msg = `Parsed ${channels.length.toLocaleString()} channels, ${totalParsed.toLocaleString()} programs...`;
            logger.info(`[XMLTV Parser] ${msg}`);
            if (onProgress) onProgress(msg);
            lastProgressTime = now;
          }
        }
        currentChannel = null;
      } else if (tagName === 'programme' && currentProgram) {
        // Validate program
        if (currentProgram.title && currentProgram.title.trim()) {
          currentProgram.id = `${currentProgram.channelId}_${currentProgram.start.getTime()}_${currentProgram.stop.getTime()}`;
          programBuffer.push(currentProgram);

          // Programs will be inserted AFTER parsing is complete and ALL channels are in the database
          // This prevents foreign key constraint violations

          // Progress every 5000 programs OR every 2 seconds
          const now = Date.now();
          const totalParsed = totalProgramsInserted + programBuffer.length;
          const shouldReport = (totalParsed % 5000 === 0) || (now - lastProgressTime >= PROGRESS_INTERVAL_MS);
          if (shouldReport) {
            const msg = `Parsed ${channels.length.toLocaleString()} channels, ${totalParsed.toLocaleString()} programs...`;
            logger.info(`[XMLTV Parser] ${msg}`);
            if (onProgress) onProgress(msg);
            lastProgressTime = now;
          }
        } else {
          skippedProgramCount++;
        }
        currentProgram = null;
      }
      currentElement = '';
    });

    // Handle parser errors
    parser.on('error', (error) => {
      saxErrorCount += 1;
      if (saxErrorCount > MAX_SAX_ERRORS) {
        if (!aborted) {
          aborted = true;
          reject(new Error(
            `[XMLTV Parser] Aborting after ${saxErrorCount} SAX errors — input is too malformed to recover`
          ));
        }
        return;
      }
      logger.warn(`[XMLTV Parser] SAX error #${saxErrorCount} (continuing): ${error.message}`);
      // SAX error recovery: `.error` and `.resume()` live on the
      // inner SAXParser, NOT on the SAXStream wrapper we get from
      // sax.createStream(). Calling them on the stream throws
      // "resume is not a function" and crashes the whole backend —
      // which is exactly what was happening on malformed XMLTV like
      // "Unclosed root tag". Guard the access in case _parser was
      // detached (e.g. after stream end).
      if (parser._parser) {
        parser._parser.error = null;
        if (typeof parser._parser.resume === 'function') {
          parser._parser.resume();
        }
      }
    });

    // Handle end of parsing - channels parsed, now start inserting
    parser.on('end', async () => {
      try {
        logger.info(`[XMLTV Parser] Parsing complete: ${channels.length} channels, ${totalProgramsInserted + programBuffer.length} programs extracted (${skippedProgramCount} programs skipped)`);

        // Deduplicate channels
        const channelMap = new Map();
        let duplicateChannelCount = 0;
        for (const channel of channels) {
          if (!channelMap.has(channel.id)) {
            channelMap.set(channel.id, channel);
          } else {
            duplicateChannelCount++;
          }
        }
        const uniqueChannels = Array.from(channelMap.values());

        if (duplicateChannelCount > 0) {
          logger.warn(`[XMLTV Parser] Found ${duplicateChannelCount} duplicate channels, keeping first occurrence`);
        }

        // CRITICAL: Insert channels FIRST before programs (foreign key constraint)
        if (dbService && uniqueChannels.length > 0) {
          if (onProgress) onProgress(`Inserting ${uniqueChannels.length.toLocaleString()} channels into database...`);
          for (let i = 0; i < uniqueChannels.length; i += BATCH_SIZE) {
            const batch = uniqueChannels.slice(i, i + BATCH_SIZE);
            await dbService.saveChannels(batch);
            const msg = `Inserted ${Math.min(i + BATCH_SIZE, uniqueChannels.length).toLocaleString()} / ${uniqueChannels.length.toLocaleString()} channels`;
            logger.info(`[XMLTV Parser] ${msg}`);
            if (onProgress) onProgress(msg);
          }
        }

        // NOW mark channels as inserted so program queue can start
        channelsInserted = true;
        logger.info(`[XMLTV Parser] Channels inserted, starting queued program insertions...`);

        // Filter to valid programs and queue remaining batches
        const validChannelIds = new Set(uniqueChannels.map(c => c.id));
        const validPrograms = programBuffer.filter(p => validChannelIds.has(p.channelId));
        const orphanedPrograms = programBuffer.length - validPrograms.length;

        if (orphanedPrograms > 0) {
          logger.warn(`[XMLTV Parser] Skipped ${orphanedPrograms} programs with invalid channel IDs`);
        }

        // Queue up remaining programs in batches
        if (dbService && validPrograms.length > 0) {
          logger.info(`[XMLTV Parser] Queueing ${validPrograms.length.toLocaleString()} remaining programs for insertion...`);

          for (let i = 0; i < validPrograms.length; i += 10000) {
            const batch = validPrograms.slice(i, i + 10000);

            // Wait if queue is full
            while (activeInsertions >= MAX_CONCURRENT_INSERTS) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }

            activeInsertions++;
            const insertionPromise = (async () => {
              try {
                await dbService.savePrograms(batch);
                totalProgramsInserted += batch.length;
                const msg = `Inserted ${totalProgramsInserted.toLocaleString()} / ${validPrograms.length.toLocaleString()} programs`;
                logger.info(`[XMLTV Parser] ${msg}`);
                if (onProgress) onProgress(msg);
              } catch (err) {
                logger.error(`[XMLTV Parser] Error inserting program batch: ${err.message}`);
                throw err;
              } finally {
                activeInsertions--;
              }
            })();

            insertionPromises.push(insertionPromise);
          }
        }

        // Wait for all queued insertions to complete
        logger.info(`[XMLTV Parser] Waiting for ${insertionPromises.length} queued insertions to complete...`);
        await Promise.all(insertionPromises);
        logger.info(`[XMLTV Parser] All program insertions complete`);


        const finalMsg = `Completed: ${uniqueChannels.length} channels, ${totalProgramsInserted} programs`;
        logger.info(`[XMLTV Parser] ${finalMsg}`);
        if (onProgress) onProgress(finalMsg);

        resolve({
          channelCount: uniqueChannels.length,
          programCount: totalProgramsInserted
        });
      } catch (err) {
        reject(err);
      }
    });

    // Create read stream (file is already decompressed by downloader)
    fs.createReadStream(filePath).pipe(parser);
  });
}

/**
 * Parse programs from XMLTV file (Pass 2)
 *
 * @param {string} filePath - Path to XMLTV file (may be gzipped)
 * @param {string} sourceId - EPG source ID
 * @param {Set<string>} validChannelIds - Set of valid channel IDs from Pass 1
 * @returns {Promise<Array>} Array of program objects
 */
async function parsePrograms(filePath, sourceId, validChannelIds, onProgress = null) {
  return new Promise((resolve, reject) => {
    const programs = [];
    let currentProgram = null;
    let currentElement = '';
    let currentCategory = '';
    let lastProgressTime = Date.now();
    let skippedCount = 0;

    // Circuit breaker for SAX errors. See parseSinglePassStreaming
    // comment for the full story — once we cross this threshold the
    // input is too corrupt to keep resume()'ing past.
    let saxErrorCount = 0;
    const MAX_SAX_ERRORS = 1000;
    let aborted = false;

    // Create SAX parser (strict mode)
    const parser = sax.createStream(true, {
      trim: true,
      normalize: true,
      lowercase: true
    });

    // Handle opening tags
    parser.on('opentag', (node) => {
      currentElement = node.name;

      if (node.name === 'programme') {
        currentProgram = {
          id: '', // Will be generated after we have all data
          channelId: node.attributes.channel || '',
          sourceId: sourceId,
          title: '',
          description: null,
          start: parseXMLTVTimestamp(node.attributes.start),
          stop: parseXMLTVTimestamp(node.attributes.stop),
          categories: []
        };
      }
    });

    // Handle text content
    parser.on('text', (text) => {
      if (!currentProgram) return;

      const trimmed = text.trim();
      if (!trimmed) return;

      switch (currentElement) {
        case 'title':
          currentProgram.title = trimmed;
          break;
        case 'desc':
          currentProgram.description = trimmed;
          break;
        case 'category':
          currentProgram.categories.push(trimmed);
          break;
      }
    });

    // Handle closing tags
    parser.on('closetag', (tagName) => {
      if (tagName === 'programme' && currentProgram) {
        // Validate: program must have title
        if (!currentProgram.title || !currentProgram.title.trim()) {
          skippedCount++;
          currentProgram = null;
          return;
        }

        // Validate: channel must exist (skip orphan programs)
        if (!validChannelIds.has(currentProgram.channelId)) {
          skippedCount++;
          currentProgram = null;
          return;
        }

        // Generate unique program ID
        currentProgram.id = `${currentProgram.channelId}_${currentProgram.start.getTime()}_${currentProgram.stop.getTime()}`;

        programs.push(currentProgram);

        // Progress reporting - show update every 5000 programs OR every 2 seconds
        const now = Date.now();
        const shouldReport = (programs.length % 5000 === 0) || (now - lastProgressTime >= PROGRESS_INTERVAL_MS);
        if (shouldReport) {
          const progressMsg = `Parsed ${programs.length.toLocaleString()} programs (skipped ${skippedCount.toLocaleString()})...`;
          logger.info(`[XMLTV Parser] ${progressMsg}`);
          if (onProgress) onProgress(progressMsg);
          lastProgressTime = now;
        }

        currentProgram = null;
      }
      currentElement = '';
    });

    // Handle parser errors
    parser.on('error', (error) => {
      saxErrorCount += 1;
      if (saxErrorCount > MAX_SAX_ERRORS) {
        if (!aborted) {
          aborted = true;
          reject(new Error(
            `[XMLTV Parser] Aborting after ${saxErrorCount} SAX errors — input is too malformed to recover`
          ));
        }
        return;
      }
      logger.warn(`[XMLTV Parser] SAX error #${saxErrorCount} (continuing): ${error.message}`);
      // SAX error recovery: `.error` and `.resume()` live on the
      // inner SAXParser, NOT on the SAXStream wrapper we get from
      // sax.createStream(). Calling them on the stream throws
      // "resume is not a function" and crashes the whole backend —
      // which is exactly what was happening on malformed XMLTV like
      // "Unclosed root tag". Guard the access in case _parser was
      // detached (e.g. after stream end).
      if (parser._parser) {
        parser._parser.error = null;
        if (typeof parser._parser.resume === 'function') {
          parser._parser.resume();
        }
      }
    });

    // Handle end of parsing
    parser.on('end', () => {
      if (aborted) return; // already rejected via circuit breaker
      logger.info(`[XMLTV Parser] Program parsing complete: ${programs.length} programs extracted, ${skippedCount} skipped`);
      resolve(programs);
    });

    // Create read stream (handle gzip automatically)
    const readStream = filePath.toLowerCase().endsWith('.gz')
      ? pipeline(
          fs.createReadStream(filePath),
          zlib.createGunzip(),
          parser,
          (err) => {
            if (err) {
              logger.error(`[XMLTV Parser] Pipeline error: ${err.message}`);
              reject(err);
            }
          }
        )
      : fs.createReadStream(filePath).pipe(parser);
  });
}

/**
 * Parse XMLTV timestamp (format: 20231115140000 +0000)
 *
 * @param {string} timestamp - XMLTV timestamp string
 * @returns {Date} JavaScript Date object
 */
function parseXMLTVTimestamp(timestamp) {
  if (!timestamp) return null;

  // XMLTV format: YYYYMMDDHHmmss +ZZZZ
  // Example: 20231115140000 +0000
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);

  if (!match) {
    logger.warn(`[XMLTV Parser] Invalid timestamp format: ${timestamp}`);
    return null;
  }

  const [_, year, month, day, hour, minute, second, timezone] = match;

  // Create UTC date
  const date = new Date(Date.UTC(
    parseInt(year),
    parseInt(month) - 1, // Month is 0-indexed
    parseInt(day),
    parseInt(hour),
    parseInt(minute),
    parseInt(second)
  ));

  // Apply timezone offset if provided
  if (timezone) {
    const sign = timezone[0] === '+' ? -1 : 1; // Reversed because we're adjusting TO UTC
    const hours = parseInt(timezone.slice(1, 3));
    const minutes = parseInt(timezone.slice(3, 5));
    const offsetMs = sign * (hours * 60 + minutes) * 60 * 1000;
    date.setTime(date.getTime() + offsetMs);
  }

  return date;
}

/**
 * Parse complete XMLTV file (two-pass strategy)
 *
 * @param {string} filePath - Path to XMLTV file
 * @param {string} sourceId - EPG source ID
 * @param {Function} onProgress - Optional progress callback
 * @param {Object} dbService - Database service for inserts (required for saving data)
 * @returns {Promise<Object>} Object with channel and program counts
 */
async function parseXMLTV(filePath, sourceId, onProgress = null, dbService = null) {
  logger.info(`[XMLTV Parser] Starting two-pass parse for ${filePath}`);

  try {
    // Pass 1: Extract channels (inserts to DB if dbService provided)
    logger.info(`[XMLTV Parser] Pass 1: Extracting channels...`);
    const channelCount = await parseChannels(filePath, sourceId, onProgress, dbService);

    if (channelCount === 0) {
      logger.warn(`[XMLTV Parser] No channels found in ${filePath}`);
      return { channelCount: 0, programCount: 0 };
    }

    // Get valid channel IDs from database
    const validChannelIds = dbService
      ? await dbService.getChannelIdsBySource(sourceId)
      : new Set();

    // Pass 2: Extract programs (only for valid channels)
    logger.info(`[XMLTV Parser] Pass 2: Extracting programs...`);
    const programs = await parsePrograms(filePath, sourceId, validChannelIds, onProgress);

    logger.info(`[XMLTV Parser] Parsing complete: ${channelCount} channels, ${programs.length} programs`);

    return { channelCount, programCount: programs.length, programs };
  } catch (error) {
    logger.error(`[XMLTV Parser] Failed to parse ${filePath}: ${error.message}`);
    throw error;
  }
}

/**
 * Parse XMLTV file in STREAMING single pass — flushes channels and programs to
 * DB as they are parsed, using SAX pause/resume for backpressure.
 *
 * Why this exists: the legacy parseSinglePass accumulates every channel and
 * program into in-memory arrays before any DB write, which OOM'd on large EPG
 * sources (e.g. 422K programs ≈ 200MB per source). This variant bounds peak
 * memory to roughly PROGRAM_BATCH_SIZE * 2 regardless of file size, exploiting
 * the XMLTV spec guarantee that all <channel> elements precede all <programme>
 * elements — so channels can be flushed on the first <programme> without
 * breaking the epg_programs.channel_id FK.
 *
 * @param {string} filePath - Path to XMLTV file (downloader has already gunzipped)
 * @param {string} sourceId - EPG source ID
 * @param {Function} onProgress - Optional progress callback
 * @param {Object} dbService - Database service (must expose saveChannels/savePrograms)
 * @returns {Promise<Object>} { channelCount, programCount }
 */
async function parseSinglePassStreaming(filePath, sourceId, onProgress = null, dbService = null) {
  if (!dbService) {
    throw new Error('[XMLTV Parser] parseSinglePassStreaming requires a dbService');
  }

  const PROGRAM_BATCH_SIZE = 10000;
  const MAX_ACTIVE_WRITES = 2;

  return new Promise((resolve, reject) => {
    const pendingChannels = [];
    const channelIdSet = new Set();
    let programBatch = [];

    let currentChannel = null;
    let currentProgram = null;
    let currentElement = '';

    let channelsFlushed = false;
    let flushingChannels = null; // promise while the one-time channel flush is in flight
    let activeWrites = 0;
    let pausedForBackpressure = false;
    let endedSignal = false;

    let totalChannels = 0;
    let totalPrograms = 0;
    let skippedPrograms = 0;
    let orphanPrograms = 0;
    let lastProgressTime = Date.now();
    let settled = false;
    let saxErrorCount = 0;
    // Circuit breaker — once SAX has emitted this many errors, the
    // input is clearly past the point where pause/resume can recover.
    // Without this, malformed mid-stream garbage caused parseSinglePass
    // -Streaming to spin forever logging SAX warnings (separate from
    // the parser.resume crash). Verified by
    // scripts/verify_xmltv_sax_recovery.js test 3.
    const MAX_SAX_ERRORS = 1000;
    // Backstop window: after readStream emits 'end', SAX usually
    // emits 'end' within milliseconds. If it hasn't after this
    // delay it's stuck in an error-recovery loop; force-finalize.
    const END_BACKSTOP_MS = 2000;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ channelCount: totalChannels, programCount: totalPrograms });
    };

    const parser = sax.createStream(true, {
      trim: true,
      normalize: true,
      lowercase: true
    });

    const readStream = fs.createReadStream(filePath);

    const pauseUpstream = () => {
      if (!pausedForBackpressure) {
        pausedForBackpressure = true;
        readStream.pause();
      }
    };
    const resumeUpstream = () => {
      if (pausedForBackpressure && activeWrites < MAX_ACTIVE_WRITES && !flushingChannels) {
        pausedForBackpressure = false;
        readStream.resume();
      }
    };

    const reportProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressTime < PROGRESS_INTERVAL_MS) return;
      lastProgressTime = now;
      const msg = `Parsed ${totalChannels.toLocaleString()} channels, ${totalPrograms.toLocaleString()} programs (streaming)`;
      logger.info(`[XMLTV Parser] ${msg}`);
      if (onProgress) onProgress(msg);
    };

    const flushChannelsOnce = () => {
      if (channelsFlushed || flushingChannels) return flushingChannels || Promise.resolve();
      pauseUpstream();
      const batch = pendingChannels.splice(0);
      flushingChannels = (async () => {
        try {
          if (batch.length > 0) {
            await dbService.saveChannels(batch);
            totalChannels += batch.length;
            for (const c of batch) channelIdSet.add(c.id);
            const msg = `Inserted ${totalChannels.toLocaleString()} channels`;
            logger.info(`[XMLTV Parser] ${msg}`);
            if (onProgress) onProgress(msg);
          }
          channelsFlushed = true;
        } finally {
          flushingChannels = null;
          resumeUpstream();
          maybeFinalize();
        }
      })();
      flushingChannels.catch((err) => finish(err));
      return flushingChannels;
    };

    const flushProgramsBatch = () => {
      if (programBatch.length === 0) return;
      const batch = programBatch;
      programBatch = [];
      activeWrites++;
      if (activeWrites >= MAX_ACTIVE_WRITES) pauseUpstream();
      dbService.savePrograms(batch)
        .then(() => {
          totalPrograms += batch.length;
          reportProgress();
        })
        .catch((err) => finish(err))
        .finally(() => {
          activeWrites--;
          resumeUpstream();
          maybeFinalize();
        });
    };

    const maybeFinalize = () => {
      if (!endedSignal) return;
      if (flushingChannels) return;
      if (activeWrites > 0) return;
      if (programBatch.length > 0) {
        flushProgramsBatch();
        return;
      }
      if (!channelsFlushed && pendingChannels.length > 0) {
        // File with only channels, no programmes — flush channels now.
        flushChannelsOnce();
        return;
      }
      reportProgress(true);
      logger.info(`[XMLTV Parser] Streaming parse complete: ${totalChannels} channels, ${totalPrograms} programs (skipped ${skippedPrograms}, orphans ${orphanPrograms})`);
      finish(null);
    };

    parser.on('opentag', (node) => {
      currentElement = node.name;

      if (node.name === 'channel') {
        currentChannel = {
          id: node.attributes.id || '',
          sourceId,
          name: '',
          icon: '',
          languageCode: null,
          categoriesCSV: null
        };
      } else if (currentChannel && node.name === 'icon' && node.attributes.src) {
        currentChannel.icon = node.attributes.src;
      } else if (node.name === 'programme') {
        if (!channelsFlushed) {
          // First programme seen — channels section is over. Flush channels now.
          flushChannelsOnce();
        }
        currentProgram = {
          id: '',
          channelId: node.attributes.channel || '',
          sourceId,
          title: '',
          description: null,
          start: parseXMLTVTimestamp(node.attributes.start),
          stop: parseXMLTVTimestamp(node.attributes.stop),
          categories: []
        };
      }
    });

    parser.on('text', (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (currentChannel && currentElement === 'display-name') {
        if (!currentChannel.name) currentChannel.name = trimmed;
      } else if (currentProgram) {
        switch (currentElement) {
          case 'title':
            currentProgram.title = trimmed;
            break;
          case 'desc':
            currentProgram.description = trimmed;
            break;
          case 'category':
            currentProgram.categories.push(trimmed);
            break;
        }
      }
    });

    parser.on('closetag', (tagName) => {
      if (tagName === 'channel' && currentChannel) {
        if (currentChannel.id && currentChannel.name) {
          pendingChannels.push(currentChannel);
        }
        currentChannel = null;
      } else if (tagName === 'programme' && currentProgram) {
        if (!currentProgram.title || !currentProgram.title.trim()) {
          skippedPrograms++;
        } else if (!currentProgram.start || !currentProgram.stop) {
          skippedPrograms++;
        } else if (!channelIdSet.has(currentProgram.channelId)) {
          orphanPrograms++;
        } else {
          currentProgram.id = `${currentProgram.channelId}_${currentProgram.start.getTime()}_${currentProgram.stop.getTime()}`;
          programBatch.push(currentProgram);
          if (programBatch.length >= PROGRAM_BATCH_SIZE) {
            flushProgramsBatch();
          }
        }
        currentProgram = null;
      }
      currentElement = '';
    });

    parser.on('error', (error) => {
      saxErrorCount += 1;
      if (saxErrorCount > MAX_SAX_ERRORS) {
        // Stop trying to recover. Earlier errors have been logged at
        // warn level; this one stops the parse entirely so the
        // bundled-EPG row gets a proper 'failed' status instead of
        // hanging the worker indefinitely.
        if (!settled) {
          finish(new Error(
            `[XMLTV Parser] Aborting after ${saxErrorCount} SAX errors — input is too malformed to recover`
          ));
        }
        return;
      }
      logger.warn(`[XMLTV Parser] SAX error #${saxErrorCount} (continuing): ${error.message}`);
      // SAX error recovery: `.error` and `.resume()` live on the
      // inner SAXParser, NOT on the SAXStream wrapper we get from
      // sax.createStream(). Calling them on the stream throws
      // "resume is not a function" and crashes the whole backend —
      // which is exactly what was happening on malformed XMLTV like
      // "Unclosed root tag". Guard the access in case _parser was
      // detached (e.g. after stream end).
      if (parser._parser) {
        parser._parser.error = null;
        if (typeof parser._parser.resume === 'function') {
          parser._parser.resume();
        }
      }
    });

    parser.on('end', () => {
      endedSignal = true;
      maybeFinalize();
    });

    readStream.on('error', (err) => finish(err));

    // Idle watchdog. The readStream-end backstop we tried first
    // doesn't fire when SAX is stuck — pipe() gates readStream's
    // 'end' on the parser draining, and a parser thrashing in error
    // recovery never drains. So instead we watch for parser-event
    // silence: if the parser hasn't fired any tag/text/error event
    // for IDLE_THRESHOLD_MS AND we're not waiting on a DB flush,
    // assume it's stuck and force-finalize.
    //
    // Cleared automatically when the parse settles (the poll sees
    // settled=true and calls clearInterval).
    const IDLE_THRESHOLD_MS = 3000;
    const POLL_MS = 1000;
    let lastParserActivity = Date.now();
    const recordActivity = () => { lastParserActivity = Date.now(); };
    parser.on('opentag', recordActivity);
    parser.on('text', recordActivity);
    parser.on('closetag', recordActivity);
    parser.on('error', recordActivity);

    const idleWatchdog = setInterval(() => {
      if (settled) {
        clearInterval(idleWatchdog);
        return;
      }
      // Active I/O = legitimately quiet (waiting on a flush). Skip.
      if (activeWrites > 0 || flushingChannels) return;
      // Backpressure = upstream paused on purpose. Skip.
      if (pausedForBackpressure) return;
      const idleFor = Date.now() - lastParserActivity;
      if (idleFor < IDLE_THRESHOLD_MS) return;

      // Truly idle. If we have NO data at all yet, the parse might
      // just be slow to start (cold disk read on a big file). Be
      // patient for the first 10s.
      if (totalChannels === 0 && totalPrograms === 0 && saxErrorCount === 0 && idleFor < 10_000) return;

      clearInterval(idleWatchdog);
      logger.warn(
        `[XMLTV Parser] Idle watchdog fired after ${idleFor}ms ` +
        `(${saxErrorCount} SAX errors, ${totalChannels} channels, ${totalPrograms} programs); force-finalizing`
      );
      if (!endedSignal) {
        endedSignal = true;
        maybeFinalize();
      }
    }, POLL_MS);
    // END_BACKSTOP_MS is no longer used directly but kept as a
    // semantic constant in case future code wants to set a shorter
    // forced-finalize delay.
    void END_BACKSTOP_MS;

    readStream.pipe(parser);
  });
}

module.exports = {
  parseSinglePass,
  parseSinglePassStreaming,
  parseXMLTV,
  parseXMLTVTimestamp
};
