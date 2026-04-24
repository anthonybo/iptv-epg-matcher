/**
 * 12-hour time with AM/PM, used by the EPG "now playing" overlay.
 * Swallows bad Date input and returns '' so the overlay never crashes
 * on malformed EPG payloads.
 */
export function formatTime(date) {
  if (!date) return '';
  try {
    const d = new Date(date);
    let hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${hours}:${minutes} ${ampm}`;
  } catch (e) {
    return '';
  }
}
