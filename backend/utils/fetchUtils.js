// utils/fetchUtils.js
const fetch = require('node-fetch');
const logger = require('../config/logger');
const { STREAM_TIMEOUT } = require('../config/constants');

/**
 * Fetches content from a URL and returns it as a buffer
 * 
 * @param {string} url - URL to fetch
 * @returns {Promise<Buffer>} Response buffer
 * @throws {Error} If fetch fails
 */
async function fetchURL(url) {
  logger.info(`Fetching URL: ${url}`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const buffer = await response.buffer();
    logger.info(`Fetched ${buffer.length} bytes from ${url}`);
    return buffer;
  } catch (e) {
    logger.error(`Fetch failed for ${url}: ${e.message}`);
    throw e;
  }
}

/**
 * Fetches a stream from a URL with timeout and custom headers
 * 
 * @param {string} url - Stream URL to fetch
 * @param {Object} headers - Custom headers to send
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Response>} Fetch response
 * @throws {Error} If fetch fails or times out
 */
async function fetchStream(url, headers = {}, timeout = STREAM_TIMEOUT) {
  logger.debug('Fetching stream', { url, headers });
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, { 
      headers,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      logger.error('Stream fetch failed', { 
        status: response.status, 
        statusText: response.statusText
      });
      throw new Error(`Stream fetch failed: ${response.status} ${response.statusText}`);
    }
    
    return response;
  } catch (e) {
    clearTimeout(timeoutId);
    
    if (e.name === 'AbortError') {
      logger.error('Stream fetch timed out', { url });
      throw new Error('Stream fetch timed out');
    }
    
    logger.error('Stream fetch error', { error: e.message, url });
    throw e;
  }
}

module.exports = {
  fetchURL,
  fetchStream
};