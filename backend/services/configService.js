/**
 * Configuration service for EPG handling
 */
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

// Configuration file path
const CONFIG_FILE = path.join(__dirname, '../config/app-config.json');
const DEFAULT_CONFIG = {
    epgSources: [],
    cacheTimeHours: 24,
    maxChannelsPerSource: 0,
    maxProgramsToProcess: 0,
    enableAutoCleanup: true,
    cleanupIntervalHours: 24
};

/**
 * Get the application configuration
 * @returns {Promise<Object>} - The application configuration
 */
async function getConfig() {
    try {
        // Check if config file exists
        if (!fs.existsSync(CONFIG_FILE)) {
            logger.info('No configuration file found, using defaults');
            return DEFAULT_CONFIG;
        }
        
        // Read config file
        const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
        const config = JSON.parse(configData);
        
        // Merge with defaults to ensure all properties exist
        return { ...DEFAULT_CONFIG, ...config };
    } catch (error) {
        logger.error(`Error reading configuration: ${error.message}`, { error });
        return DEFAULT_CONFIG;
    }
}

/**
 * Save the application configuration
 * @param {Object} config - The configuration to save
 * @returns {Promise<boolean>} - Whether the save was successful
 */
async function saveConfig(config) {
    try {
        // Ensure config directory exists
        const configDir = path.dirname(CONFIG_FILE);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        
        // Save config file
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        logger.info('Configuration saved successfully');
        return true;
    } catch (error) {
        logger.error(`Error saving configuration: ${error.message}`, { error });
        return false;
    }
}

/**
 * Update specific configuration properties
 * @param {Object} updates - The properties to update
 * @returns {Promise<Object>} - The updated configuration
 */
async function updateConfig(updates) {
    try {
        const currentConfig = await getConfig();
        const updatedConfig = { ...currentConfig, ...updates };
        
        await saveConfig(updatedConfig);
        logger.info('Configuration updated successfully');
        
        return updatedConfig;
    } catch (error) {
        logger.error(`Error updating configuration: ${error.message}`, { error });
        return await getConfig(); // Return current config if update fails
    }
}

/**
 * Add a new EPG source URL to the configuration
 * @param {string} url - The EPG source URL to add
 * @returns {Promise<Object>} - The updated configuration
 */
async function addEpgSource(url) {
    try {
        if (!url || typeof url !== 'string') {
            throw new Error('Invalid EPG source URL');
        }
        
        const config = await getConfig();
        
        // Add URL if not already in the list
        if (!config.epgSources.includes(url)) {
            config.epgSources.push(url);
            await saveConfig(config);
            logger.info(`Added EPG source: ${url}`);
        } else {
            logger.info(`EPG source already exists: ${url}`);
        }
        
        return config;
    } catch (error) {
        logger.error(`Error adding EPG source: ${error.message}`, { error });
        return await getConfig();
    }
}

/**
 * Remove an EPG source URL from the configuration
 * @param {string} url - The EPG source URL to remove
 * @returns {Promise<Object>} - The updated configuration
 */
async function removeEpgSource(url) {
    try {
        const config = await getConfig();
        
        // Remove URL if it exists
        const index = config.epgSources.indexOf(url);
        if (index !== -1) {
            config.epgSources.splice(index, 1);
            await saveConfig(config);
            logger.info(`Removed EPG source: ${url}`);
        } else {
            logger.info(`EPG source not found: ${url}`);
        }
        
        return config;
    } catch (error) {
        logger.error(`Error removing EPG source: ${error.message}`, { error });
        return await getConfig();
    }
}

/**
 * Get EPG sources from config file AND user-added sources from database
 * @returns {Promise<Array>} - Array of EPG source objects {url, name}
 */
async function getEpgSources() {
    try {
        const sources = [];

        // 1. Load system sources from config file
        const EPG_SOURCES_FILE = path.join(__dirname, '../config/epg_sources.json');

        if (fs.existsSync(EPG_SOURCES_FILE)) {
            const data = fs.readFileSync(EPG_SOURCES_FILE, 'utf8');
            const config = JSON.parse(data);

            // Filter for enabled sources and return in format {url, name}
            const systemSources = (config.sources || [])
                .filter(source => source.enabled)
                .map(source => ({
                    url: source.url,
                    name: source.name
                }));

            sources.push(...systemSources);
            logger.info(`Loaded ${systemSources.length} enabled system EPG sources from config`);
        } else {
            logger.warn('EPG sources file not found');
        }

        // 2. Load user-added sources from PostgreSQL
        try {
            const postgresService = require('./postgresService');
            const result = await postgresService.query(`
                SELECT url, name
                FROM user_epg_sources
                WHERE enabled = true
                ORDER BY created_at ASC
            `);

            if (result.rows.length > 0) {
                sources.push(...result.rows);
                logger.info(`Loaded ${result.rows.length} enabled user EPG sources from database`);
            }
        } catch (dbError) {
            logger.warn(`Could not load user EPG sources from database: ${dbError.message}`);
        }

        logger.info(`Total EPG sources: ${sources.length} (system + user)`);
        return sources;
    } catch (error) {
        logger.error(`Error getting EPG sources: ${error.message}`);
        return [];
    }
}

module.exports = {
    getConfig,
    saveConfig,
    updateConfig,
    addEpgSource,
    removeEpgSource,
    getEpgSources
}; 