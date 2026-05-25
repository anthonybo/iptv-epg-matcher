/**
 * LLM routes — operational endpoints for the multi-provider rotation
 * client.
 *
 *   GET  /api/llm/status            — provider registry snapshot
 *   POST /api/llm/test              — body: { prompt } → runs the prompt through
 *                                     the rotation, returns the chosen provider +
 *                                     completion. Useful for smoke-testing after
 *                                     adding keys to .env.
 *
 * Both endpoints require auth (same pattern as the rest of the app).
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const { isLlmReady, getProviderStatus, generateCompletion } = require('../services/llm/client');

router.use(authMiddleware);

router.get('/status', (req, res) => {
  res.json({ success: true, ...getProviderStatus() });
});

router.post('/test', async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'prompt is required' });
  }
  if (!isLlmReady()) {
    return res.status(503).json({
      success: false,
      error: 'LLM not ready. Check LLM_ENABLED + LLM_API_KEY_* env vars.'
    });
  }
  const t0 = Date.now();
  try {
    const reply = await generateCompletion(
      [
        { role: 'system', content: 'You are a concise assistant. Answer in <100 words.' },
        { role: 'user', content: prompt }
      ],
      { maxTokens: 240, timeoutMs: 30_000 }
    );
    if (!reply) {
      return res.status(502).json({
        success: false,
        error: 'All providers failed or rate-limited.',
        elapsedMs: Date.now() - t0
      });
    }
    res.json({ success: true, reply, elapsedMs: Date.now() - t0 });
  } catch (err) {
    logger.error('[llm/test] unexpected error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
