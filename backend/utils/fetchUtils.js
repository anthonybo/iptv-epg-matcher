// utils/fetchUtils.js
const fetch = require('node-fetch');
const logger = require('../config/logger');
const { STREAM_TIMEOUT } = require('../config/constants');

/**
 * Fetches content from a URL and returns the response
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options (timeout, headers, etc.)
 * @returns {Promise<Response>} Fetch response
 * @throws {Error} If fetch fails
 */
async function fetchURL(url, options = {}) {
  logger.info(`Fetching URL: ${url}`);
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      // Build a more descriptive error message
      const statusText = response.statusText || 'Unknown Error';
      let errorMessage = `HTTP ${response.status}: ${statusText}`;

      // Add additional context for non-standard status codes
      if (response.status >= 500 && response.status < 600) {
        errorMessage += ' (Server Error)';
      }

      // Try to get response body for more details (limit to first 500 chars)
      try {
        const body = await response.text();
        if (body && body.length > 0) {
          const preview = body.substring(0, 500);
          logger.error(`Response body preview: ${preview}`);
          // Don't include the body in the thrown error to avoid exposing sensitive info
        }
      } catch (bodyError) {
        // Ignore if we can't read the body
      }

      throw new Error(errorMessage);
    }
    logger.info(`Fetched response from ${url} with status ${response.status}`);
    return response;
  } catch (e) {
    // Enhance error message for network errors
    let errorMsg = e.message;
    if (e.code === 'ENOTFOUND') {
      errorMsg = `Unable to reach server: ${url} (DNS lookup failed)`;
    } else if (e.code === 'ECONNREFUSED') {
      errorMsg = `Connection refused by server: ${url}`;
    } else if (e.code === 'ETIMEDOUT') {
      errorMsg = `Request timed out: ${url}`;
    } else if (e.code === 'CERT_HAS_EXPIRED' || e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      errorMsg = `SSL certificate error for ${url}`;
    }

    logger.error(`Fetch failed for ${url}: ${errorMsg}`);
    throw new Error(errorMsg);
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