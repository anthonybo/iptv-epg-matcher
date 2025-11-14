/**
 * Video quality detection utilities
 */

/**
 * Detects video quality from video element dimensions
 * @param {number} width - Video width in pixels
 * @param {number} height - Video height in pixels
 * @returns {Object|null} Quality info object with { resolution: string, width: number, height: number } or null if invalid
 */
export const detectVideoQuality = (width, height) => {
  // Validate that dimensions are available (not 0)
  if (!height || !width) {
    return null;
  }

  let resolution = null;

  if (height >= 2160) {
    resolution = '4K';
  } else if (height >= 1440) {
    resolution = '2K';
  } else if (height >= 1080) {
    resolution = '1080p';
  } else if (height >= 720) {
    resolution = '720p';
  } else if (height >= 480) {
    resolution = '480p';
  } else if (height > 0) {
    resolution = `${height}p`;
  }

  if (!resolution) {
    return null;
  }

  return {
    resolution,
    width,
    height
  };
};

/**
 * Sets up video quality detection listeners on a video element
 * @param {HTMLVideoElement} videoElement - The video element to monitor
 * @param {Function} onQualityDetected - Callback when quality is detected or changes
 * @param {Function} log - Optional logging function
 * @returns {Function} Cleanup function to remove event listeners
 */
export const setupVideoQualityDetection = (videoElement, onQualityDetected, log = console.log) => {
  if (!videoElement || !onQualityDetected) {
    return () => {};
  }

  const detectAndReport = (eventType = 'check') => {
    const quality = detectVideoQuality(videoElement.videoWidth, videoElement.videoHeight);

    if (quality) {
      log('info', `Video quality detected (${eventType}): ${quality.resolution} (${quality.width}x${quality.height})`);
      onQualityDetected(quality);
    }
  };

  // Detect initial quality when video starts playing
  const handlePlaying = () => detectAndReport('playing');

  // Detect quality changes (adaptive bitrate streams)
  const handleResize = () => detectAndReport('resize');

  videoElement.addEventListener('playing', handlePlaying);
  videoElement.addEventListener('resize', handleResize);

  // Return cleanup function
  return () => {
    videoElement.removeEventListener('playing', handlePlaying);
    videoElement.removeEventListener('resize', handleResize);
  };
};
