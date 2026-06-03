/**
 * AI Channel Matching — status + toggle API for the dashboard.
 *
 *   GET  /api/ai-matching/status  → flag state, LLM readiness, aggregates, recent feed
 *   POST /api/ai-matching/toggle  → { enabled: bool } flips the feature flag at runtime
 *
 * Auth-protected (unlike routes/settings.js) because this is an admin
 * control surfaced on the dashboard.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');
const featureFlags = require('../services/featureFlags');
const aiMatchStats = require('../services/aiMatchStats');
const { isLlmReady, getProviderStatus } = require('../services/llm/client');
const webSearch = require('../services/llm/webSearch');

const FLAG = 'ai_channel_matching';
const WEB_SEARCH_FLAG = 'web_search_provider';

/**
 * GET /api/ai-matching/status
 * Everything the dashboard panel needs in one call.
 */
router.get('/status', authMiddleware, requireAuth, async (req, res) => {
  try {
    const sinceHours = Math.min(720, Math.max(1, parseInt(req.query.hours, 10) || 168));
    const [aggregates, recent] = await Promise.all([
      aiMatchStats.getAggregates({ sinceHours }),
      aiMatchStats.getRecent(12),
    ]);

    let providerCount = 0;
    try {
      const ps = getProviderStatus();
      providerCount = (ps.providers || []).filter((p) => !p.rateLimited).length;
    } catch (_) { /* non-fatal */ }

    res.json({
      enabled: featureFlags.isEnabled(FLAG, false),
      llmReady: isLlmReady(),
      providerCount,
      aggregates,
      recent,
      webSearch: webSearch.getStatus(),
    });
  } catch (error) {
    logger.error(`[AI Matching] status failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to load AI matching status' });
  }
});

/**
 * POST /api/ai-matching/web-search-provider  { provider: 'auto'|'groq'|'gemini' }
 * Choose which web-search backend to use (or 'auto' to smart-pick).
 */
router.post('/web-search-provider', authMiddleware, requireAuth, (req, res) => {
  try {
    const { provider } = req.body || {};
    const allowed = ['auto', ...webSearch.PROVIDER_IDS];
    if (!allowed.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${allowed.join(', ')}` });
    }
    featureFlags.setValue(WEB_SEARCH_FLAG, provider);
    logger.info(`[AI Matching] web_search_provider = ${provider} (by user ${req.user?.id ?? '?'})`);
    res.json({ provider, webSearch: webSearch.getStatus() });
  } catch (error) {
    logger.error(`[AI Matching] set web-search provider failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to set web-search provider' });
  }
});

/**
 * POST /api/ai-matching/toggle  { enabled: boolean }
 * Runtime kill switch — no restart needed.
 */
router.post('/toggle', authMiddleware, requireAuth, (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must include { enabled: boolean }' });
    }
    const value = featureFlags.setFlag(FLAG, enabled);
    logger.info(`[AI Matching] ${value ? 'ENABLED' : 'DISABLED'} by user ${req.user?.id ?? '?'}`);
    res.json({ enabled: value });
  } catch (error) {
    logger.error(`[AI Matching] toggle failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to toggle AI matching' });
  }
});

module.exports = router;
