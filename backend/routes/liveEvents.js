/**
 * Live Events Routes
 * API endpoints for managing live sports events data.
 *
 * The original monolithic file was split into focused submodules under
 * backend/routes/liveEvents/. This file just wires them together, applies
 * auth once, and keeps the existing mount point (server.js) working.
 */

const express = require('express');
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');

const eventsRouter = require('./liveEvents/events');
const randomWorkingStreamRouter = require('./liveEvents/randomWorkingStream');
const eventChannelsRouter = require('./liveEvents/eventChannels');
const randomAnyChannelRouter = require('./liveEvents/randomAnyChannel');
const searchChannelRouter = require('./liveEvents/searchChannel');
const channelCandidatesRouter = require('./liveEvents/channelCandidates');
const blacklistRouter = require('./liveEvents/blacklist');
const sportsRandomRouter = require('./liveEvents/sportsRandom');
const autoFillRouter = require('./liveEvents/autoFill');
const localNewsRouter = require('./liveEvents/localNews');

const router = express.Router();

// Apply auth to every live-events endpoint.
router.use(authMiddleware);

// Each submodule is a full Router, mounted at the root so paths are unchanged.
// Order matches the original routes/liveEvents.js registration order so that
// Express path matching stays identical.
router.use('/', eventsRouter);
router.use('/', randomWorkingStreamRouter);
router.use('/', eventChannelsRouter);
router.use('/', randomAnyChannelRouter);
router.use('/', searchChannelRouter);
router.use('/', channelCandidatesRouter);
router.use('/', blacklistRouter);
router.use('/', sportsRandomRouter);
router.use('/', autoFillRouter);
router.use('/', localNewsRouter);

logger.info('[LiveEvents] HTTP/HTTPS connection pooling enabled (maxSockets: 10)');

module.exports = router;
