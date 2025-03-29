const xml2js = require('xml2js');
const crypto = require('crypto');

function parseM3U(m3uContent, logger) {
  const lines = m3uContent.split('\n').map(line => line.trim());
  const channels = [];
  let channelCount = 0;
  let currentChannel = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines or the M3U header
    if (!line || line.startsWith('#EXTM3U')) continue;

    // Parse #EXTINF lines
    if (line.startsWith('#EXTINF')) {
      channelCount++;
      const extInfMatch = line.match(/^#EXTINF:-?\d+\s*(.*?),(.+)/);
      if (!extInfMatch) {
        logger.warn(`Invalid #EXTINF line at ${i}: ${line}`);
        continue;
      }

      const attributesStr = extInfMatch[1];
      const name = extInfMatch[2].trim();

      // Parse attributes (e.g., tvg-id="...", group-title="...")
      const attributes = {};
      const attrMatches = attributesStr.matchAll(/(\w+-\w+|\w+)="([^"]*)"/g);
      for (const match of attrMatches) {
        attributes[match[1]] = match[2];
      }

      const tvgId = attributes['tvg-id'] || `channel_${crypto.createHash('md5').update(name + channelCount).digest('hex')}`;
      const groupTitle = attributes['group-title'] || 'Uncategorized';
      const tvgName = attributes['tvg-name'] || name;

      currentChannel = { tvgId, name: tvgName, groupTitle };
    }
    // Parse the URL (the line after #EXTINF)
    else if (currentChannel && line && !line.startsWith('#')) {
      currentChannel.url = line;
      channels.push(currentChannel);
      currentChannel = null;
    }
  }

  const uniqueChannels = Array.from(new Map(channels.map(ch => [ch.tvgId, ch])).values());
  logger.debug(`Filtered ${channelCount} M3U entries to ${uniqueChannels.length} unique channels`);
  return uniqueChannels;
}

function parseEPG(epgContent, logger) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(epgContent, (err, result) => {
      if (err) {
        logger.error('Failed to parse EPG', { error: err.message });
        return reject(err);
      }

      const channels = result.tv.channel || [];
      const programs = result.tv.programme || [];
      logger.info(`Parsed EPG: ${channels.length} channels, ${programs.length} programs`);
      logger.debug(`First 500 chars of EPG: ${epgContent.substring(0, 500)}`);
      resolve({ channels, programs });
    });
  });
}

function matchChannels(channels, xtreamEPG, externalEPG, logger, matchedChannels = {}) {
  const epgChannels = { ...xtreamEPG.channels, ...externalEPG.channels };
  const updatedChannels = channels.map(ch => {
    const matchedId = matchedChannels[ch.tvgId] || ch.tvgId;
    const epgChannel = epgChannels.find(epgCh => epgCh.$.id === matchedId);
    if (epgChannel) {
      ch.tvgId = matchedId;
    }
    return ch;
  });

  logger.info(`Matched ${Object.keys(matchedChannels).length} channels with EPG`);
  return updatedChannels;
}

function generateEPG(channels) {
  const xmlBuilder = new xml2js.Builder();
  const epg = {
    tv: {
      channel: channels.map(ch => ({
        $: { id: ch.tvgId },
        'display-name': [ch.name]
      })),
      programme: []
    }
  };

  return xmlBuilder.buildObject(epg);
}

module.exports = { parseM3U, parseEPG, matchChannels, generateEPG };