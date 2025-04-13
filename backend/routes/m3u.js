/**
 * M3U Routes
 * Handles M3U playlist related operations
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { getSession, updateSession } = require('../utils/storageUtils');

/**
 * GET /:sessionId
 * Get M3U channels for a session
 */
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { category, page = 1, limit = 100 } = req.query;
    
    logger.info(`Getting M3U channels for session ${sessionId}`);
    
    // Get session
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Check if session has channels
    if (!session.channels || !Array.isArray(session.channels)) {
      return res.status(200).json({
        success: true,
        channels: [],
        totalChannels: 0,
        page: 1,
        totalPages: 0,
        message: 'No channels found in session'
      });
    }
    
    // Filter channels by category if specified
    let filteredChannels = session.channels;
    if (category && category !== 'all') {
      filteredChannels = session.channels.filter(
        channel => channel.groupTitle === category
      );
    }
    
    // Calculate pagination
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;
    const paginatedChannels = filteredChannels.slice(startIndex, endIndex);
    const totalPages = Math.ceil(filteredChannels.length / limitNum);
    
    return res.json({
      success: true,
      channels: paginatedChannels,
      totalChannels: filteredChannels.length,
      page: pageNum,
      totalPages,
      category: category || 'all'
    });
  } catch (error) {
    logger.error(`Error getting M3U channels: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: `Error getting M3U channels: ${error.message}`
    });
  }
});

/**
 * GET /:sessionId/categories
 * Get all categories from an M3U playlist
 */
router.get('/:sessionId/categories', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    logger.info(`Getting M3U categories for session ${sessionId}`);
    
    // Get session
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Check if session has channels
    if (!session.channels || !Array.isArray(session.channels)) {
      return res.status(200).json({
        success: true,
        categories: [],
        message: 'No channels found in session'
      });
    }
    
    // Extract unique categories
    const categories = [...new Set(
      session.channels
        .map(channel => channel.groupTitle)
        .filter(Boolean)
    )].sort();
    
    return res.json({
      success: true,
      categories,
      count: categories.length
    });
  } catch (error) {
    logger.error(`Error getting M3U categories: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: `Error getting M3U categories: ${error.message}`
    });
  }
});

module.exports = router; 