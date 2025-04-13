/**
 * Utils for managing the cache directory
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../config/logger');

/**
 * Get the cache directory path
 * @param {string} subDirectory - Optional subdirectory within the cache
 * @returns {string} - Full path to the cache directory
 */
function getCacheDir(subDirectory = '') {
    // Define base cache directory - prefer a dedicated cache dir in the app,
    // but fall back to OS temp dir if needed
    let baseCacheDir;
    
    try {
        // First try to use the app's cache directory
        baseCacheDir = path.resolve(__dirname, '../../cache');
        
        // Create it if it doesn't exist
        if (!fs.existsSync(baseCacheDir)) {
            fs.mkdirSync(baseCacheDir, { recursive: true });
            logger.info(`Created cache directory: ${baseCacheDir}`);
        }
    } catch (error) {
        // Fall back to system temp directory
        baseCacheDir = path.join(os.tmpdir(), 'epg-matcher-cache');
        logger.warn(`Using system temp directory for cache: ${baseCacheDir}`);
        
        // Create it if it doesn't exist
        if (!fs.existsSync(baseCacheDir)) {
            fs.mkdirSync(baseCacheDir, { recursive: true });
        }
    }
    
    // If a subdirectory is specified, include it in the path
    if (subDirectory) {
        const fullPath = path.join(baseCacheDir, subDirectory);
        
        // Create the subdirectory if it doesn't exist
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
        
        return fullPath;
    }
    
    return baseCacheDir;
}

/**
 * Get a path in the cache directory
 * @param {string} filename - Name of the file
 * @param {string} subDirectory - Optional subdirectory within the cache
 * @returns {string} - Full path to the file in the cache
 */
function getCachePath(filename, subDirectory = '') {
    const cacheDir = getCacheDir(subDirectory);
    return path.join(cacheDir, filename);
}

/**
 * Ensures the cache directory exists
 * @param {string} subDirectory - Optional subdirectory within the cache
 * @returns {string} - Path to the cache directory
 */
function ensureCacheDir(subDirectory = '') {
    return getCacheDir(subDirectory);
}

/**
 * Cleans up old files in the cache directory
 * @param {number} maxAgeDays - Maximum age of files in days
 * @param {string} subDirectory - Optional subdirectory within the cache
 * @returns {number} - Number of files deleted
 */
function cleanupOldCacheFiles(maxAgeDays = 7, subDirectory = '') {
    const cacheDir = getCacheDir(subDirectory);
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    
    try {
        const files = fs.readdirSync(cacheDir);
        
        for (const file of files) {
            const filePath = path.join(cacheDir, file);
            
            try {
                const stats = fs.statSync(filePath);
                
                // Skip directories
                if (stats.isDirectory()) continue;
                
                // Check if the file is older than maxAgeDays
                if (now - stats.mtime.getTime() > maxAgeMs) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                    logger.debug(`Deleted old cache file: ${filePath}`);
                }
            } catch (fileError) {
                logger.warn(`Error processing cache file ${filePath}: ${fileError.message}`);
            }
        }
        
        logger.info(`Cleaned up ${deletedCount} old files from cache directory ${cacheDir}`);
        return deletedCount;
    } catch (error) {
        logger.error(`Error cleaning cache directory ${cacheDir}: ${error.message}`);
        return 0;
    }
}

module.exports = {
    getCacheDir,
    getCachePath,
    ensureCacheDir,
    cleanupOldCacheFiles
}; 