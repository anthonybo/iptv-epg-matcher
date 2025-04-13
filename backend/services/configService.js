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

module.exports = {
    getConfig,
    saveConfig,
    updateConfig,
    addEpgSource,
    removeEpgSource
}; 