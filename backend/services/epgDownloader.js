/**
 * EPG Downloader Service - Handle downloading and caching of EPG files
 * Replaces download logic from Python epg_parser.py
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../config/logger');
const { CACHE_DIR } = require('../config/constants');

const CACHE_TTL_HOURS = 24;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 EPGParser/1.0';

/**
 * Generate cache filename from URL
 *
 * @param {string} url - EPG source URL
 * @returns {string} Safe filename for caching
 */
function generateCacheFilename(url) {
  // For long URLs, use MD5 hash
  if (url.length > 200) {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const ext = path.extname(url) || '.xml';
    return `epg_${hash}${ext}`;
  }

  // For shorter URLs, create safe filename
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .substring(0, 200);
}

/**
 * Get full cache file path
 *
 * @param {string} url - EPG source URL
 * @returns {string} Full path to cache file
 */
function getCachePath(url) {
  const filename = generateCacheFilename(url);
  return path.join(CACHE_DIR, filename);
}

/**
 * Check if cached file is valid (exists and < 24 hours old)
 *
 * @param {string} filePath - Path to cached file
 * @returns {boolean} True if cache is valid
 */
function isCacheValid(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    const stats = fs.statSync(filePath);
    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

    return ageHours < CACHE_TTL_HOURS;
  } catch (error) {
    logger.error(`[EPG Downloader] Error checking cache: ${error.message}`);
    return false;
  }
}

/**
 * Get cache age in hours
 *
 * @param {string} filePath - Path to cached file
 * @returns {number|null} Age in hours, or null if file doesn't exist
 */
function getCacheAge(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stats = fs.statSync(filePath);
    return (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
  } catch (error) {
    return null;
  }
}

/**
 * Download EPG file from URL
 *
 * @param {string} url - EPG source URL
 * @param {string} destPath - Destination file path
 * @param {Function} onProgress - Optional progress callback
 * @returns {Promise<boolean>} True if download succeeded
 */
async function downloadFile(url, destPath, onProgress = null) {
  logger.info(`[EPG Downloader] Downloading ${url}...`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT
      },
      timeout: 120000 // 2 minute timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Get content length for progress tracking
    const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
    let downloaded = 0;
    let lastProgress = 0;      // last logged percent (Content-Length path)
    let lastLoggedBytes = 0;   // bytes downloaded at last log (no-Content-Length path)
    const PROGRESS_STEP_BYTES = 25 * 1024 * 1024; // log once per 25 MB

    // Create write stream
    const fileStream = fs.createWriteStream(destPath);

    // Stream response to file with progress tracking
    return new Promise((resolve, reject) => {
      response.body.on('data', (chunk) => {
        downloaded += chunk.length;

        // Report progress every 10%
        if (totalSize > 0) {
          const percent = Math.floor((downloaded / totalSize) * 100);
          if (percent >= lastProgress + 10) {
            const downloadedMB = (downloaded / (1024 * 1024)).toFixed(2);
            const totalMB = (totalSize / (1024 * 1024)).toFixed(2);
            const progressMsg = `Downloaded ${downloadedMB} MB of ${totalMB} MB (${percent}%)`;
            logger.info(`[EPG Downloader] ${progressMsg}`);
            if (onProgress) onProgress(progressMsg);
            lastProgress = percent;
          }
        } else {
          // No Content-Length: log once per 25 MB. The old modulo check
          // (`downloaded % 10MB < 1MB`) stayed true for a full 1MB window
          // after every boundary, so it fired on dozens of consecutive
          // ~16KB chunks — flooding the log. Track bytes since last log.
          if (downloaded - lastLoggedBytes >= PROGRESS_STEP_BYTES) {
            lastLoggedBytes = downloaded;
            const downloadedMB = (downloaded / (1024 * 1024)).toFixed(2);
            const progressMsg = `Downloaded ${downloadedMB} MB...`;
            logger.info(`[EPG Downloader] ${progressMsg}`);
            if (onProgress) onProgress(progressMsg);
          }
        }
      });

      response.body.pipe(fileStream);

      fileStream.on('finish', () => {
        const downloadedMB = (downloaded / (1024 * 1024)).toFixed(2);
        logger.info(`[EPG Downloader] Download complete: ${downloadedMB} MB`);
        resolve(true);
      });

      fileStream.on('error', (error) => {
        logger.error(`[EPG Downloader] File write error: ${error.message}`);
        reject(error);
      });

      response.body.on('error', (error) => {
        logger.error(`[EPG Downloader] Download error: ${error.message}`);
        reject(error);
      });
    });
  } catch (error) {
    logger.error(`[EPG Downloader] Failed to download ${url}: ${error.message}`);
    return false;
  }
}

/**
 * Decompress gzipped file to disk (if not already decompressed)
 *
 * @param {string} gzPath - Path to .gz file
 * @param {string} outPath - Path to output uncompressed file
 * @param {Function} onProgress - Optional progress callback
 * @returns {Promise<boolean>} True if successful
 */
async function decompressFile(gzPath, outPath, onProgress = null) {
  logger.info(`[EPG Downloader] Decompressing ${gzPath} to ${outPath}...`);
  if (onProgress) onProgress(`Decompressing EPG file...`);

  // Reject zero-byte .gz cache files up front — they come from downloads that
  // returned 200 but an empty body (seen on some flaky EPG providers). gunzip
  // on an empty stream throws "unexpected end of file" asynchronously, which
  // escaped this function's Promise and crashed the process.
  try {
    const st = fs.statSync(gzPath);
    if (st.size === 0) {
      try { fs.unlinkSync(gzPath); } catch (_) { /* ignore */ }
      throw new Error(`Gzip file is empty (0 bytes): ${gzPath}`);
    }
  } catch (err) {
    throw err;
  }

  return new Promise((resolve, reject) => {
    const gunzip = require('zlib').createGunzip();
    const input = fs.createReadStream(gzPath);
    const output = fs.createWriteStream(outPath);

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      logger.error(`[EPG Downloader] Decompression error: ${err.message}`);
      try { input.destroy(); } catch (_) {}
      try { gunzip.destroy(); } catch (_) {}
      try { output.destroy(); } catch (_) {}
      // Remove the corrupt .gz so a future refresh redownloads it.
      try { fs.unlinkSync(gzPath); } catch (_) {}
      reject(err);
    };

    input.on('error', fail);
    gunzip.on('error', fail);
    output.on('error', fail);

    input.pipe(gunzip).pipe(output);

    output.on('finish', () => {
      if (settled) return;
      settled = true;
      logger.info(`[EPG Downloader] Decompression complete: ${outPath}`);
      if (onProgress) onProgress(`Decompression complete`);
      resolve(true);
    });
  });
}

/**
 * Download EPG file with caching
 *
 * @param {string} url - EPG source URL
 * @param {Object} options - Download options
 * @param {boolean} options.force - Force download even if cache is valid
 * @param {boolean} options.cache - Use caching (default: true)
 * @param {Function} options.onProgress - Optional progress callback
 * @returns {Promise<string|null>} Path to downloaded/cached file, or null on failure
 */
async function download(url, options = {}) {
  const { force = false, cache = true, onProgress = null } = options;

  // Ensure cache directory exists
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const cachePath = getCachePath(url);

  // Check if valid cache exists (unless force is true)
  if (!force && cache && isCacheValid(cachePath)) {
    const ageHours = getCacheAge(cachePath);
    logger.info(`[EPG Downloader] Using cached file (age: ${ageHours.toFixed(1)} hours): ${cachePath}`);
    if (onProgress) onProgress(`Using cached EPG data (${ageHours.toFixed(0)}h old)`);

    // If it's a .gz file, check if decompressed version exists
    if (cachePath.endsWith('.gz')) {
      const decompressedPath = cachePath.replace('.gz', '');
      if (!fs.existsSync(decompressedPath)) {
        logger.info(`[EPG Downloader] Decompressed version not found, decompressing...`);
        await decompressFile(cachePath, decompressedPath, onProgress);
      }
      return decompressedPath;
    }

    return cachePath;
  }

  // Try to download
  logger.info(`[EPG Downloader] Cache ${force ? 'forced refresh' : 'expired or missing'}, downloading...`);
  const downloadSuccess = await downloadFile(url, cachePath, onProgress);

  if (downloadSuccess) {
    // If downloaded a .gz file, decompress it immediately
    if (cachePath.endsWith('.gz')) {
      const decompressedPath = cachePath.replace('.gz', '');
      await decompressFile(cachePath, decompressedPath, onProgress);
      return decompressedPath;
    }
    return cachePath;
  }

  // Download failed - try to use stale cache as fallback
  if (cache && fs.existsSync(cachePath)) {
    const ageHours = getCacheAge(cachePath);
    logger.warn(`[EPG Downloader] Download failed, using stale cache (age: ${ageHours.toFixed(1)} hours)`);

    // If it's a .gz file, check if decompressed version exists
    if (cachePath.endsWith('.gz')) {
      const decompressedPath = cachePath.replace('.gz', '');
      if (!fs.existsSync(decompressedPath)) {
        await decompressFile(cachePath, decompressedPath, onProgress);
      }
      return decompressedPath;
    }

    return cachePath;
  }

  // Both download and cache failed
  logger.error(`[EPG Downloader] Download failed and no cache available for ${url}`);
  return null;
}

/**
 * Clear cache for specific URL or all cache
 *
 * @param {string|null} url - EPG source URL, or null to clear all cache
 * @returns {boolean} True if successful
 */
function clearCache(url = null) {
  try {
    if (url) {
      const cachePath = getCachePath(url);
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
        logger.info(`[EPG Downloader] Cleared cache for ${url}`);
      }
    } else {
      // Clear all cache files
      if (fs.existsSync(CACHE_DIR)) {
        const files = fs.readdirSync(CACHE_DIR);
        files.forEach(file => {
          if (file.startsWith('epg_')) {
            fs.unlinkSync(path.join(CACHE_DIR, file));
          }
        });
        logger.info(`[EPG Downloader] Cleared all EPG cache (${files.length} files)`);
      }
    }
    return true;
  } catch (error) {
    logger.error(`[EPG Downloader] Error clearing cache: ${error.message}`);
    return false;
  }
}

/**
 * Get cache statistics
 *
 * @returns {Object} Cache statistics
 */
function getCacheStats() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return { count: 0, totalSize: 0, files: [] };
    }

    const files = fs.readdirSync(CACHE_DIR)
      .filter(file => file.startsWith('epg_'))
      .map(file => {
        const filePath = path.join(CACHE_DIR, file);
        const stats = fs.statSync(filePath);
        const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

        return {
          filename: file,
          sizeBytes: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          ageHours: ageHours.toFixed(1),
          isValid: ageHours < CACHE_TTL_HOURS
        };
      });

    const totalSize = files.reduce((sum, file) => sum + file.sizeBytes, 0);

    return {
      count: files.length,
      totalSize: totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      files: files
    };
  } catch (error) {
    logger.error(`[EPG Downloader] Error getting cache stats: ${error.message}`);
    return { count: 0, totalSize: 0, files: [] };
  }
}

module.exports = {
  download,
  clearCache,
  getCacheStats,
  getCachePath,
  isCacheValid,
  getCacheAge
};
