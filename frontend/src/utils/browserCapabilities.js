/**
 * browserCapabilities — one-shot probe of what the browser can actually
 * decode via Media Source Extensions. Used by the VOD player to pick
 * the right backend tier (direct, transmux, transcode) per movie.
 *
 * Gotchas worth knowing:
 *
 *   1. `MediaSource.isTypeSupported` returns `true` on Chrome whenever
 *      the OS has a hardware HEVC decoder. The MSE pipe still works
 *      fine for tagged-`hev1` content. But on weak hardware (cheap
 *      Linux laptop without VAAPI, Windows machine without Microsoft's
 *      paid HEVC extension) it lies and playback silently fails
 *      mid-stream. Don't TRUST the result — record it as a hint and
 *      fall back to a server transcode if MSE rejects.
 *
 *   2. AC-3/EAC-3 audio is the silent killer. ~the same prevalence as
 *      HEVC in modern CAM/4K content; only Safari plays them natively.
 *      Chrome and Firefox always say `false`.
 *
 *   3. MKV: Chrome accepts it as a container (`isTypeSupported` returns
 *      true for `video/x-matroska`) but the actual codec inside still
 *      has to be MSE-compatible — so probing the *codec* alone is
 *      sufficient and the container test is redundant.
 *
 * The probe runs once at module load and caches the result. There's
 * no need to re-run; capabilities don't change without a browser
 * restart.
 */

function detectCapabilities() {
  // MSE not available at all (rare in 2026 — SSR or test envs only).
  if (typeof window === 'undefined' || typeof window.MediaSource === 'undefined') {
    return {
      mseAvailable: false,
      canH264: false,
      canHevc: false,
      canHevcMain10: false,
      canAv1: false,
      canAac: false,
      canAc3: false,
      canEac3: false,
      canMp3: false
    };
  }

  const isSupported = (type) => {
    try { return window.MediaSource.isTypeSupported(type); } catch (_) { return false; }
  };

  // Codec strings:
  //   avc1.42E01E  → H.264 Baseline 3.0
  //   avc1.640028  → H.264 High 4.0 (used by most 1080p mp4)
  //   hev1.1.6.L93.B0  → HEVC Main 8-bit Level 3.1
  //   hev1.2.4.L120.B0 → HEVC Main10 10-bit Level 4.0 (4K HDR)
  //   av01.0.05M.08    → AV1 Main 8-bit Level 5.0
  //   mp4a.40.2    → AAC-LC
  //   mp4a.40.5    → AAC HE
  //   ac-3 / ec-3  → Dolby AC-3 / EAC-3 (E-AC-3)
  return {
    mseAvailable: true,
    canH264: isSupported('video/mp4; codecs="avc1.640028"') ||
             isSupported('video/mp4; codecs="avc1.42E01E"'),
    canHevc: isSupported('video/mp4; codecs="hev1.1.6.L93.B0"') ||
             isSupported('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    canHevcMain10: isSupported('video/mp4; codecs="hev1.2.4.L120.B0"') ||
                   isSupported('video/mp4; codecs="hvc1.2.4.L120.B0"'),
    canAv1: isSupported('video/mp4; codecs="av01.0.05M.08"'),
    canAac: isSupported('audio/mp4; codecs="mp4a.40.2"'),
    canAc3: isSupported('audio/mp4; codecs="ac-3"'),
    canEac3: isSupported('audio/mp4; codecs="ec-3"'),
    canMp3: isSupported('audio/mp4; codecs="mp3"') ||
            isSupported('audio/mpeg'),
    // Matroska as a container — Chrome plays it for H.264/AAC, Firefox
    // and Safari don't. We use this to avoid transmuxing a mkv-with-
    // h264-aac on Chrome where the browser would handle it natively.
    canMkv: isSupported('video/x-matroska; codecs="avc1.640028,mp4a.40.2"') ||
            isSupported('video/webm; codecs="vp9,opus"')
  };
}

let cached = null;
export function browserCapabilities() {
  if (!cached) {
    cached = detectCapabilities();
    // Visible in devtools when debugging "why is this re-encoding."
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.info('[browserCapabilities]', cached);
    }
  }
  return cached;
}

/**
 * Given probe data and capabilities, pick the right URL flavor:
 *   - 'direct'      → original `/api/vod-stream/movie/:id` proxy
 *   - 'copy'        → `/api/vod-stream/transmux/movie/:id?mode=copy`
 *   - 'audio_only'  → transmux with audio re-encode
 *   - 'video_only'  → transmux with video re-encode
 *   - 'full'        → transmux with both re-encoded
 *
 * Mirrors backend `pickPlaybackMode` so the decision is consistent
 * regardless of which side the choice happens on. We do it on the
 * client because the SAME upstream can need different modes for
 * different browsers — see the Plex Chrome.xml story in the survey.
 */
export function pickPlaybackTier(probe, container) {
  const caps = browserCapabilities();
  const ext = String(container || '').toLowerCase();

  // No probe data (probe failed or hasn't run yet) — extension hint.
  if (!probe || !probe.vcodec) {
    if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') {
      return { tier: 'direct', reason: 'no probe; container looks native' };
    }
    if (ext === 'mkv') {
      // Risky — could contain HEVC/AC-3. Default to transmux. ffmpeg
      // with -c copy will Just Work for H.264/AAC in mkv (~70% of mkv
      // content), and we surface an error if it doesn't.
      return { tier: 'copy', reason: 'no probe; .mkv often needs repackage' };
    }
    return { tier: 'copy', reason: `no probe; .${ext} not native, attempting transmux` };
  }

  const vc = String(probe.vcodec || '').toLowerCase();
  const ac = String(probe.acodec || '').toLowerCase();
  const cont = String(probe.container || '').toLowerCase();

  const vOk = (vc === 'h264' && caps.canH264) || (vc === 'hevc' && caps.canHevc);
  const aOk = (ac === 'aac' && caps.canAac) ||
              (ac === 'mp3' && caps.canMp3) ||
              (ac === 'ac3' && caps.canAc3) ||
              (ac === 'eac3' && caps.canEac3);

  if (vOk && aOk && (cont.includes('mp4') || cont === 'mov' || cont === 'm4v')) {
    return { tier: 'direct', reason: `mp4 ${vc}/${ac} — native playback` };
  }
  // Matroska direct play on Chrome (when the browser admits to it).
  // Saves an ffmpeg transmux for a lot of the .mkv catalog.
  if (vOk && aOk && cont.includes('matroska') && caps.canMkv) {
    return { tier: 'direct', reason: `mkv ${vc}/${ac} — native playback` };
  }
  if (vOk && aOk) {
    return { tier: 'copy', reason: `${vc}/${ac} OK, repackaging ${cont || ext} → fMP4` };
  }
  if (vOk && !aOk) {
    return { tier: 'audio_only', reason: `${vc} OK, transcoding audio from ${ac}` };
  }
  if (!vOk && aOk) {
    return { tier: 'video_only', reason: `${ac} OK, transcoding video from ${vc}` };
  }
  return { tier: 'full', reason: `transcoding video (${vc}) + audio (${ac})` };
}
