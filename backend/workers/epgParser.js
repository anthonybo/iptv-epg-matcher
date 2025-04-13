// workers/epgParser.js
const { parentPort } = require('worker_threads');
const xml2js = require('xml2js');

/**
 * Worker thread to parse EPG data in the background
 * Sends progress updates to the main thread
 */
parentPort.on('message', async (message) => {
  if (message.epgContent) {
    try {
      // Report started
      progress(0.05, 'Starting EPG parsing');
      
      // Parse in chunks to avoid blocking
      const result = await parseEPGInChunks(message.epgContent);
      
      // Send complete message
      parentPort.postMessage({
        type: 'complete',
        data: result
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        error: error.message
      });
    }
  }
});

// Report progress
function progress(value, message) {
  parentPort.postMessage({
    type: 'progress',
    progress: value,
    details: { message }
  });
}

// Parse EPG in chunks
async function parseEPGInChunks(epgContent) {
  return new Promise((resolve, reject) => {
    // First check if it's valid XML
    if (!epgContent.includes('<?xml') || !epgContent.includes('<tv')) {
      reject(new Error('Invalid XML structure'));
      return;
    }
    
    // Parse in a non-blocking way
    progress(0.1, 'Parsing XML data');
    
    xml2js.parseString(epgContent, (err, result) => {
      if (err) {
        progress(0.15, `Error parsing XML: ${err.message}`);
        reject(err);
        return;
      }
      
      if (!result || !result.tv) {
        progress(0.2, 'Invalid EPG structure: missing tv element');
        reject(new Error('Invalid EPG structure'));
        return;
      }
      
      const channels = result.tv.channel || [];
      const programs = result.tv.programme || [];
      
      progress(0.25, `Found ${channels.length} channels and ${programs.length} programs`);
      
      // Process channels in batches
      processInBatches(channels, programs, resolve);
    });
  });
}

// Process data in batches to avoid blocking
function processInBatches(channels, programs, resolve) {
  // Initialize result
  const result = {
    channels: channels,
    programs: programs,
    channelMap: {},
    programMap: {}
  };
  
  // Step 1: Build channel map
  const totalSteps = 3;
  const batchSize = 1000;
  let currentChannel = 0;
  
  function processChannelBatch() {
    const endIdx = Math.min(currentChannel + batchSize, channels.length);
    
    for (let i = currentChannel; i < endIdx; i++) {
      const channel = channels[i];
      
      if (!channel.$ || !channel.$.id) continue;
      
      const originalId = channel.$.id;
      
      // Add the original ID
      result.channelMap[originalId] = channel;
      
      // Add lowercase version
      result.channelMap[originalId.toLowerCase()] = channel;
      
      // Add snake_case version
      const snakeCase = originalId.toLowerCase().replace(/\s+/g, '_').replace(/[^\w_]/g, '');
      result.channelMap[snakeCase] = channel;
      
      // Add version without 'hd' at the end
      if (originalId.toLowerCase().endsWith('hd')) {
        const noHdId = originalId.toLowerCase().slice(0, -2).trim();
        result.channelMap[noHdId] = channel;
        
        // Also add snake_case without HD
        const snakeCaseNoHd = snakeCase.replace(/_?hd$/, '');
        result.channelMap[snakeCaseNoHd] = channel;
      }
      
      // Add versions from display-name
      if (channel['display-name']) {
        channel['display-name'].forEach(name => {
          let displayName;
          
          if (typeof name === 'string') {
            displayName = name;
          } else if (name._ && typeof name._ === 'string') {
            displayName = name._;
          }
          
          if (displayName) {
            // Original display name
            result.channelMap[displayName.trim()] = channel;
            
            // Lowercase
            result.channelMap[displayName.toLowerCase().trim()] = channel;
            
            // Snake case
            result.channelMap[displayName.toLowerCase().replace(/\s+/g, '_').replace(/[^\w_]/g, '')] = channel;
            
            // No spaces
            result.channelMap[displayName.toLowerCase().replace(/\s+/g, '')] = channel;
            
            // Without HD suffix
            if (displayName.toLowerCase().endsWith('hd')) {
              result.channelMap[displayName.toLowerCase().slice(0, -2).trim()] = channel;
            }
          }
        });
      }
    }
    
    currentChannel = endIdx;
    const channelProgress = currentChannel / channels.length;
    progress(0.25 + (channelProgress * 0.25), `Building channel map: ${currentChannel} of ${channels.length}`);
    
    if (currentChannel < channels.length) {
      // Process next batch
      setTimeout(processChannelBatch, 0);
    } else {
      // Start processing programs
      processProgramBatch();
    }
  }
  
  // Step 2: Build program map
  let currentProgram = 0;
  
  function processProgramBatch() {
    const endIdx = Math.min(currentProgram + batchSize, programs.length);
    
    for (let i = currentProgram; i < endIdx; i++) {
      const program = programs[i];
      
      if (!program.$ || !program.$.channel) continue;
      
      const channelId = program.$.channel;
      if (!result.programMap[channelId]) {
        result.programMap[channelId] = [];
      }
      result.programMap[channelId].push(program);
    }
    
    currentProgram = endIdx;
    const programProgress = currentProgram / programs.length;
    progress(0.5 + (programProgress * 0.45), `Building program map: ${currentProgram} of ${programs.length}`);
    
    if (currentProgram < programs.length) {
      // Process next batch
      setTimeout(processProgramBatch, 0);
    } else {
      // All processing complete
      progress(0.95, `Finalizing EPG data: ${channels.length} channels, ${programs.length} programs`);
      
      // Log channel ID samples for debugging
      if (channels.length > 0) {
        const channelIdSamples = channels.slice(0, 5).map(ch => ch.$ ? ch.$.id : 'unknown');
        progress(0.97, `Sample channel IDs: ${channelIdSamples.join(', ')}`);
      }
      
      // Log program channel reference samples
      if (programs.length > 0) {
        const programRefSamples = programs.slice(0, 5).map(p => p.$ ? p.$.channel : 'unknown');
        progress(0.98, `Sample program channel refs: ${programRefSamples.join(', ')}`);
      }
      
      progress(1.0, `EPG processing complete. ${channels.length} channels, ${programs.length} programs, ${Object.keys(result.channelMap).length} channel mappings, ${Object.keys(result.programMap).length} program mappings`);
      
      resolve(result);
    }
  }
  
  // Start channel processing
  processChannelBatch();
}