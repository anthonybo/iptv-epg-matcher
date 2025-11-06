// routes/generate.js
/**
 * Generate Route - handles generating new XTREAM credentials
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../config/logger');
const { generateCredentials } = require('../utils/storageUtils');
const { UPLOADS_DIR } = require('../config/constants');
const { authMiddleware } = require('../middleware/authMiddleware');
const iptvDatabaseService = require('../services/iptvDatabaseService');

/**
 * Get the local network IP address of the server
 * (Same logic as /api/network-info endpoint used for Chromecast)
 */
function getServerIpAddress() {
  const networkInterfaces = os.networkInterfaces();
  const addresses = [];

  // Find all non-internal IPv4 addresses
  Object.keys(networkInterfaces).forEach(interfaceName => {
    networkInterfaces[interfaceName].forEach(iface => {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    });
  });

  // Return the first valid address, or localhost if none found
  return addresses.length > 0 ? addresses[0] : 'localhost';
}

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * GET /api/generate
 * Get all generated XTREAM credentials for the authenticated user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get credentials: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const db = await iptvDatabaseService.connect();

    // Get all credentials for this user
    const credentials = await new Promise((resolve, reject) => {
      db.all(`
        SELECT
          id,
          username,
          password,
          credential_id,
          channel_count,
          created_at,
          last_accessed
        FROM generated_credentials
        WHERE user_id = ?
        ORDER BY created_at DESC
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    // Add URLs to each credential
    const serverIp = getServerIpAddress();
    const port = process.env.PORT || 5001;
    const baseUrl = process.env.BASE_URL || `http://${serverIp}:${port}`;

    const credentialsWithUrls = credentials.map(cred => ({
      ...cred,
      xtreamUrl: `${baseUrl}/api/xtream`,
      xtreamEpgUrl: `${baseUrl}/api/xtream/xmltv.php?username=${cred.username}&password=${cred.password}`,
      m3uUrl: `${baseUrl}/api/xtream/get.php?username=${cred.username}&password=${cred.password}&type=m3u_plus&output=ts`
    }));

    res.json({
      credentials: credentialsWithUrls,
      count: credentialsWithUrls.length
    });
  } catch (error) {
    logger.error('Get credentials failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/generate/:credentialId
 * Delete a generated credential
 */
router.delete('/:credentialId', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { credentialId } = req.params;

    if (!userId) {
      logger.error('Delete credential: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const db = await iptvDatabaseService.connect();

    // Delete the credential (only if it belongs to this user)
    const result = await new Promise((resolve, reject) => {
      db.run(`
        DELETE FROM generated_credentials
        WHERE credential_id = ? AND user_id = ?
      `, [credentialId, userId], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

    if (result === 0) {
      return res.status(404).json({ error: 'Credential not found or access denied' });
    }

    logger.info(`Deleted credential ${credentialId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Credential deleted successfully'
    });
  } catch (error) {
    logger.error('Delete credential failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/generate
 * Generates new XTREAM credentials based on user's matched channels from database
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Generate: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    logger.info(`Generating XTREAM credentials for user ${userId}`);

    // Connect to database
    const db = await iptvDatabaseService.connect();

    // Get all matched channels for this user from the database
    const matchedChannels = await new Promise((resolve, reject) => {
      db.all(`
        SELECT
          m.iptv_channel_id,
          m.iptv_channel_name,
          m.epg_channel_id,
          m.epg_channel_name,
          m.epg_source_name,
          m.epg_source_id,
          c.name,
          c.logo,
          c.url,
          c.group_title,
          s.id as source_id,
          s.name as source_name,
          s.url as source_url,
          s.username as source_username,
          s.password as source_password,
          s.type as source_type
        FROM epg_matches m
        JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE m.user_id = ?
        ORDER BY c.name
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (!matchedChannels || matchedChannels.length === 0) {
      logger.warn(`No matched channels found for user ${userId}`);
      return res.status(400).json({
        error: 'No matched channels found. Please match channels in the Guide first.',
        matchCount: 0
      });
    }

    logger.info(`Found ${matchedChannels.length} matched channels for user ${userId}`);

    // Generate new credentials
    const { username, password } = generateCredentials();

    // Get server info for stream URLs
    const serverIp = getServerIpAddress();
    const port = process.env.PORT || 5001;
    const baseUrl = process.env.BASE_URL || `http://${serverIp}:${port}`;

    // Generate M3U playlist content with proxied stream URLs
    const m3uLines = ['#EXTM3U'];

    matchedChannels.forEach(channel => {
      // Build EXTINF line with channel metadata
      const tvgId = channel.epg_channel_id || '';
      const tvgName = channel.name || channel.iptv_channel_name;
      const tvgLogo = channel.logo || '';
      const groupTitle = channel.group_title || 'Matched Channels';

      m3uLines.push(
        `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${tvgLogo}" group-title="${groupTitle}",${tvgName}`
      );

      // Use proxied stream URL instead of direct URL
      const streamUrl = `${baseUrl}/api/xtream/stream/${encodeURIComponent(channel.iptv_channel_id)}?username=${username}&password=${password}`;
      m3uLines.push(streamUrl);
    });

    const m3uContent = m3uLines.join('\n');

    // Generate EPG XML content for matched channels
    const epgChannelIds = [...new Set(matchedChannels.map(ch => ch.epg_channel_id).filter(Boolean))];

    // Get EPG data from the EPG database
    const epgDbPath = path.join(__dirname, '../data/epg.db');
    const sqlite3 = require('sqlite3').verbose();
    const epgDb = new sqlite3.Database(epgDbPath);

    const epgPrograms = await new Promise((resolve, reject) => {
      if (epgChannelIds.length === 0) {
        return resolve([]);
      }

      const placeholders = epgChannelIds.map(() => '?').join(',');
      epgDb.all(`
        SELECT channel_id, title, start, stop, description, category
        FROM programs
        WHERE channel_id IN (${placeholders})
        AND substr(stop, 1, 14) >= strftime('%Y%m%d%H%M%S', 'now')
        ORDER BY channel_id, start
        LIMIT 1000
      `, epgChannelIds, (err, rows) => {
        if (err) {
          logger.warn(`Error fetching EPG data: ${err.message}`);
          resolve([]);
        } else {
          logger.info(`Fetched ${rows ? rows.length : 0} EPG programs for XMLTV generation`);
          resolve(rows || []);
        }
      });
    });

    epgDb.close();

    // Build XMLTV format EPG
    const xmlLines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
      '<tv generator-info-name="IPTV EPG Matcher">'
    ];

    // Add channel definitions
    const uniqueChannelIds = new Set();
    matchedChannels.forEach(ch => {
      if (ch.epg_channel_id && !uniqueChannelIds.has(ch.epg_channel_id)) {
        uniqueChannelIds.add(ch.epg_channel_id);
        xmlLines.push(`  <channel id="${escapeXml(ch.epg_channel_id)}">`);
        xmlLines.push(`    <display-name>${escapeXml(ch.name || ch.epg_channel_name)}</display-name>`);
        if (ch.logo) {
          xmlLines.push(`    <icon src="${escapeXml(ch.logo)}" />`);
        }
        xmlLines.push(`  </channel>`);
      }
    });

    // Add program data
    epgPrograms.forEach(prog => {
      xmlLines.push(`  <programme start="${prog.start}" stop="${prog.stop}" channel="${escapeXml(prog.channel_id)}">`);
      xmlLines.push(`    <title>${escapeXml(prog.title || 'Unknown')}</title>`);
      if (prog.description) {
        xmlLines.push(`    <desc>${escapeXml(prog.description)}</desc>`);
      }
      if (prog.category) {
        xmlLines.push(`    <category>${escapeXml(prog.category)}</category>`);
      }
      xmlLines.push(`  </programme>`);
    });

    xmlLines.push('</tv>');
    const epgContent = xmlLines.join('\n');

    // Save generated files
    const credentialId = `${userId}_${Date.now()}`;
    const m3uFilePath = path.join(UPLOADS_DIR, `${credentialId}.m3u`);
    const epgFilePath = path.join(UPLOADS_DIR, `${credentialId}.xml`);

    fs.writeFileSync(m3uFilePath, m3uContent);
    fs.writeFileSync(epgFilePath, epgContent);

    // Store credentials in database for XTREAM API access
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT OR REPLACE INTO generated_credentials
        (user_id, username, password, credential_id, m3u_file, epg_file, channel_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [userId, username, password, credentialId, m3uFilePath, epgFilePath, matchedChannels.length], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // XTREAM API server URL (base URL without credentials)
    const xtreamServerUrl = `${baseUrl}/api/xtream`;

    // Full M3U and EPG URLs (for reference/download)
    const m3uUrl = `${baseUrl}/api/xtream/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
    const epgUrl = `${baseUrl}/api/xtream/xmltv.php?username=${username}&password=${password}`;

    logger.info(`Using base URL: ${baseUrl} (server IP: ${serverIp})`);
    logger.info(`Generated XTREAM credentials for user ${userId}: ${matchedChannels.length} channels, username=${username}`);

    res.json({
      xtreamUrl: xtreamServerUrl,      // Base XTREAM server URL
      xtreamEpgUrl: epgUrl,             // EPG URL with credentials
      m3uUrl: m3uUrl,                   // Direct M3U URL (for download)
      username,
      password,
      channelCount: matchedChannels.length,
      downloadUrl: `/api/download/${credentialId}`,
      notes: `Generated with ${matchedChannels.length} matched channels`
    });
  } catch (error) {
    logger.error('Generate failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Helper function to escape XML special characters
 */
function escapeXml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = router;
