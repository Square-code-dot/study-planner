// Small formatting helpers shared by the views and the reminder text.

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Whole calendar days from b to a. Rounding absorbs daylight-saving shifts.
export function dayDiff(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / DAY);
}

export function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDate(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtDue(d, now = new Date()) {
  const diff = dayDiff(d, now);
  if (diff === 0) return `Today ${fmtTime(d)}`;
  if (diff === 1) return `Tomorrow ${fmtTime(d)}`;
  if (diff === -1) return `Yesterday ${fmtTime(d)}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${fmtTime(d)}`;
  return `${fmtDate(d)}, ${fmtTime(d)}`;
}

// For text that is read later (phone pushes), where "Today" would be wrong.
export function fmtDueAbsolute(d) {
  return `${fmtDate(d)}, ${fmtTime(d)}`;
}

export function fmtRelative(d, now = new Date()) {
  const ms = d - now;
  const abs = Math.abs(ms);
  let span;
  if (abs < HOUR) span = `${Math.max(1, Math.round(abs / 60_000))}m`;
  else if (abs < 48 * HOUR) span = `${Math.round(abs / HOUR)}h`;
  else span = `${Math.round(abs / DAY)}d`;
  return ms >= 0 ? `in ${span}` : `${span} late`;
}

export function fmtHours(h) {
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${Math.round(h * 10) / 10}h`;
}

export function fmtWeekdayNarrow(d) {
  return d.toLocaleDateString([], { weekday: 'narrow' });
}

// Value for <input type="datetime-local">, in local time.
export function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
