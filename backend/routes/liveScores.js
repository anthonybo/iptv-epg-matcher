/**
 * Live Scores API Routes
 * Endpoints for fetching and managing live sports scores
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const liveScoresService = require('../services/liveScoresService');

/**
 * GET /api/live-scores
 * Get all live scores for currently playing games
 */
router.get('/', async (req, res) => {
  try {
    const scores = await liveScoresService.getLiveScores();
    res.json({
      success: true,
      count: scores.length,
      scores
    });
  } catch (error) {
    logger.error('Error fetching live scores:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live scores'
    });
  }
});

/**
 * GET /api/live-scores/all
 * Get all scores (live, recent, and upcoming)
 */
router.get('/all', async (req, res) => {
  try {
    const scores = await liveScoresService.getAllScores();
    res.json({
      success: true,
      count: scores.length,
      scores
    });
  } catch (error) {
    logger.error('Error fetching all scores:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch scores'
    });
  }
});

/**
 * GET /api/live-scores/:eventId
 * Get score for a specific event
 */
router.get('/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const score = await liveScoresService.getScoreByEventId(eventId);

    if (!score) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }

    res.json({
      success: true,
      score
    });
  } catch (error) {
    logger.error('Error fetching score:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch score'
    });
  }
});

/**
 * POST /api/live-scores/refresh
 * Manually trigger a score update
 */
router.post('/refresh', async (req, res) => {
  try {
    logger.info('Manual score refresh triggered');
    const result = await liveScoresService.updateAllScores();

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Error refreshing scores:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh scores'
    });
  }
});

/**
 * GET /api/live-scores/status
 * Get the status of the background update service
 */
router.get('/service/status', async (req, res) => {
  try {
    const isRunning = liveScoresService.isBackgroundUpdatesRunning();
    res.json({
      success: true,
      backgroundUpdatesRunning: isRunning
    });
  } catch (error) {
    logger.error('Error getting service status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get service status'
    });
  }
});

module.exports = router;
