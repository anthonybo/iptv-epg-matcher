/**
 * Settings routes - handles application settings
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Settings file path
const CONFIG_DIR = path.join(__dirname, '../config');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        logger.info(`Created config directory: ${CONFIG_DIR}`);
    } catch (error) {
        logger.error(`Failed to create config directory: ${error.message}`);
    }
}

// Helper to load settings
const loadSettings = () => {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        logger.error(`Error loading settings: ${error.message}`);
    }
    
    // Return empty settings object if file doesn't exist or there's an error
    return {};
};

// Helper to save settings
const saveSettings = (settings) => {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.error(`Error saving settings: ${error.message}`);
        return false;
    }
};

/**
 * GET /
 * Get all settings
 */
router.get('/', (req, res) => {
    const settings = loadSettings();
    res.json({
        success: true,
        settings,
        message: 'Settings retrieved successfully'
    });
});

/**
 * GET /:key
 * Get a specific setting by key
 */
router.get('/:key', (req, res) => {
    const { key } = req.params;
    const settings = loadSettings();
    
    if (settings.hasOwnProperty(key)) {
        res.json({
            success: true,
            key,
            value: settings[key]
        });
    } else {
        res.json({
            success: false,
            key,
            value: null,
            message: `Setting '${key}' not found`
        });
    }
});

/**
 * POST /:key
 * Set a specific setting
 */
router.post('/:key', (req, res) => {
    const { key } = req.params;
    const { value } = req.body;
    
    if (!key) {
        return res.status(400).json({
            success: false,
            message: 'Setting key is required'
        });
    }
    
    let settings = loadSettings();
    settings[key] = value;
    
    const saved = saveSettings(settings);
    
    if (saved) {
        res.json({
            success: true,
            key,
            value,
            message: `Setting '${key}' saved successfully`
        });
    } else {
        res.status(500).json({
            success: false,
            message: 'Failed to save settings'
        });
    }
});

/**
 * DELETE /:key
 * Delete a specific setting
 */
router.delete('/:key', (req, res) => {
    const { key } = req.params;
    
    let settings = loadSettings();
    
    if (settings.hasOwnProperty(key)) {
        delete settings[key];
        const saved = saveSettings(settings);
        
        if (saved) {
            res.json({
                success: true,
                key,
                message: `Setting '${key}' deleted successfully`
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to save settings after deletion'
            });
        }
    } else {
        res.status(404).json({
            success: false,
            message: `Setting '${key}' not found`
        });
    }
});

module.exports = router; 