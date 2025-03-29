/**
 * Cache Cleanup Utility
 * 
 * Helps manage the cache directory by cleaning up old files
 * and maintaining disk space usage
 */
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { CACHE_DIR, CACHE_TTL } = require('../config/constants');

/**
 * Gets the total size of a directory and its contents in bytes
 * 
 * @param {string} dirPath - Directory path to check
 * @returns {number} Size in bytes
 */
function getDirSize(dirPath) {
  let size = 0;
  
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stats = fs.statSync(filePath);
    
    if (stats.isDirectory()) {
      size += getDirSize(filePath);
    } else {
      size += stats.size;
    }
  }
  
  return size;
}

/**
 * Formats a file size in bytes to a human-readable string
 * 
 * @param {number} bytes - Size in bytes
 * @returns {string} Human-readable size
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Removes expired cache files to free up disk space
 * 
 * @param {number} maxAgeDays - Maximum age of files to keep in days
 * @returns {Object} Result with counts and sizes
 */
function cleanupExpiredCache(maxAgeDays = 7) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      logger.info(`Cache directory does not exist: ${CACHE_DIR}`);
      return { success: true, message: 'No cache directory found' };
    }
    
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffTime = now - maxAgeMs;
    
    // Gather stats before cleanup
    const sizeBefore = getDirSize(CACHE_DIR);
    
    let filesRemoved = 0;
    let bytesRemoved = 0;
    let dirsRemoved = 0;
    
    // Process directories first to find chunk directories
    const processDir = (dirPath) => {
      const items = fs.readdirSync(dirPath);
      
      // First pass: handle files
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stats = fs.statSync(itemPath);
        
        if (!stats.isDirectory()) {
          if (stats.mtimeMs < cutoffTime) {
            // Skip removing index files for now
            if (!item.includes('epgSources.json')) {
              bytesRemoved += stats.size;
              fs.unlinkSync(itemPath);
              filesRemoved++;
            }
          }
        }
      }
      
      // Second pass: handle directories and index files
      // This ensures we don't delete an index file before its chunk directory
      const dirs = [];
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stats = fs.statSync(itemPath);
        
        if (stats.isDirectory()) {
          dirs.push(itemPath);
        } else if (item.includes('epgSources.json') && stats.mtimeMs < cutoffTime) {
          // Check if there's a corresponding chunk directory
          const chunkDir = `${itemPath}_chunks`;
          if (fs.existsSync(chunkDir)) {
            // Remove the entire chunk directory
            const chunkDirSize = getDirSize(chunkDir);
            removeDirectory(chunkDir);
            bytesRemoved += chunkDirSize;
            dirsRemoved++;
          }
          
          // Now remove the index file itself
          bytesRemoved += stats.size;
          fs.unlinkSync(itemPath);
          filesRemoved++;
        }
      }
      
      // Process subdirectories
      for (const dir of dirs) {
        if (dir.endsWith('_chunks')) {
          // Skip chunk directories - they're handled with their index files
          continue;
        }
        processDir(dir);
      }
    };
    
    // Start processing from the cache root
    processDir(CACHE_DIR);
    
    // Gather stats after cleanup
    const sizeAfter = getDirSize(CACHE_DIR);
    
    const result = {
      success: true,
      filesRemoved,
      dirsRemoved,
      bytesRemoved,
      bytesRemovedFormatted: formatSize(bytesRemoved),
      cacheSizeBefore: formatSize(sizeBefore),
      cacheSizeAfter: formatSize(sizeAfter),
      percentReduced: sizeBefore > 0 ? ((sizeBefore - sizeAfter) / sizeBefore * 100).toFixed(2) + '%' : '0%'
    };
    
    logger.info(`Cache cleanup completed`, result);
    return result;
  } catch (error) {
    logger.error(`Cache cleanup failed: ${error.message}`, { error });
    return { success: false, error: error.message };
  }
}

/**
 * Recursively removes a directory and all its contents
 * 
 * @param {string} dirPath - Directory to remove
 */
function removeDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      
      if (fs.statSync(itemPath).isDirectory()) {
        removeDirectory(itemPath);
      } else {
        fs.unlinkSync(itemPath);
      }
    }
    
    fs.rmdirSync(dirPath);
  }
}

/**
 * Sets up periodic cache cleanup
 * 
 * @param {number} intervalHours - How often to check and clean cache in hours
 * @param {number} maxAgeDays - Maximum age of files to keep in days
 */
function setupPeriodicCleanup(intervalHours = 24, maxAgeDays = 7) {
  // Run cleanup immediately at startup
  cleanupExpiredCache(maxAgeDays);
  
  // Set up periodic cleanup
  const intervalMs = intervalHours * 60 * 60 * 1000;
  setInterval(() => {
    logger.info(`Running scheduled cache cleanup (max age: ${maxAgeDays} days)`);
    cleanupExpiredCache(maxAgeDays);
  }, intervalMs);
  
  logger.info(`Scheduled periodic cache cleanup every ${intervalHours} hours`);
}

module.exports = {
  cleanupExpiredCache,
  setupPeriodicCleanup,
  getDirSize,
  formatSize
};