/**
 * XMLTV Generator Utility
 * Generates XMLTV XML from published EPG data in the database
 */

const logger = require('./logger');

/**
 * Escape XML special characters
 */
const escapeXml = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

/**
 * Format PostgreSQL timestamp to XMLTV format (YYYYMMDDHHMMSS +0000)
 * Expects timestamp as string "YYYY-MM-DD HH:MM:SS" already in UTC
 */
const formatXmltvTime = (timestamp) => {
  if (!timestamp) return '';

  // If it's a string like "2025-11-19 04:35:00", parse it directly as UTC
  if (typeof timestamp === 'string') {
    const parts = timestamp.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (parts) {
      const [, year, month, day, hour, minute, second] = parts;
      return `${year}${month}${day}${hour}${minute}${second} +0000`;
    }
  }

  // Fallback for Date objects (though we should avoid these now)
  const pad = (n) => String(n).padStart(2, '0');
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  const second = pad(date.getUTCSeconds());

  return `${year}${month}${day}${hour}${minute}${second} +0000`;
};

/**
 * Generate XMLTV from published EPG data
 *
 * @param {Array} epgData - Array of published EPG rows from database
 * @returns {String} - XMLTV XML string
 */
const generateXmltvFromDatabase = (epgData) => {
  try {
    logger.info(`Generating XMLTV from ${epgData.length} EPG programs`);

    const xmlLines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
      '<tv generator-info-name="IPTV Guru">'
    ];

    // Group programs by channel
    const channelMap = new Map();
    epgData.forEach(row => {
      const channelId = row.epg_channel_id;
      if (!channelMap.has(channelId)) {
        channelMap.set(channelId, {
          id: channelId,
          name: row.channel_name,
          logo: row.logo_url,
          programs: []
        });
      }
      channelMap.get(channelId).programs.push(row);
    });

    // Add channel definitions
    channelMap.forEach((channel, channelId) => {
      xmlLines.push(`  <channel id="${escapeXml(channelId)}">`);
      xmlLines.push(`    <display-name>${escapeXml(channel.name)}</display-name>`);
      if (channel.logo) {
        xmlLines.push(`    <icon src="${escapeXml(channel.logo)}" />`);
      }
      xmlLines.push(`  </channel>`);
    });

    // Add program data
    epgData.forEach(prog => {
      const startTime = formatXmltvTime(prog.start_time);
      const stopTime = formatXmltvTime(prog.stop_time);

      if (!startTime || !stopTime) {
        logger.warn(`Skipping program with invalid times: ${prog.title}`);
        return;
      }

      xmlLines.push(`  <programme start="${startTime}" stop="${stopTime}" channel="${escapeXml(prog.epg_channel_id)}">`);
      xmlLines.push(`    <title>${escapeXml(prog.title)}</title>`);

      if (prog.description) {
        xmlLines.push(`    <desc>${escapeXml(prog.description)}</desc>`);
      }

      if (prog.categories) {
        xmlLines.push(`    <category>${escapeXml(prog.categories)}</category>`);
      }

      xmlLines.push(`  </programme>`);
    });

    xmlLines.push('</tv>');

    const xmlContent = xmlLines.join('\n');
    logger.info(`Generated XMLTV: ${channelMap.size} channels, ${epgData.length} programs, ${xmlContent.length} bytes`);

    return xmlContent;
  } catch (error) {
    logger.error(`Error generating XMLTV: ${error.message}`);
    throw error;
  }
};

module.exports = {
  generateXmltvFromDatabase,
  escapeXml,
  formatXmltvTime
};
