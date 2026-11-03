// Reminders: system notifications on this device, plus optional phone pushes scheduled on an ntfy server.
import { fmtDue, fmtDueAbsolute } from './format.js';

const MIN = 60_000;
const NTFY_MAX_AHEAD = 71 * 60 * MIN; // ntfy.sh holds scheduled messages for up to 3 days
const NTFY_BATCH = 12; // per run, to stay well under ntfy.sh's request limits

export const OFFSET_OPTIONS = [[10080, '1 week'], [4320, '3 days'], [1440, '1 day'], [360, '6 hours'], [180, '3 hours'], [60, '1 hour']];

// Changing a due date changes the key, so the new date gets its own reminders.
const keyOf = (a, offset) => `${a.id}|${offset}|${Date.parse(a.due)}`;

export const canNotify = () => 'Notification' in window;

export async function requestPermission() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export async function notify(title, body, tag) {
  if (!canNotify() || Notification.permission !== 'granted') return false;
  const options = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

function reminderText(state, a, absolute) {
  const course = state.courses.find((c) => c.id === a.courseId)?.name;
  const due = new Date(a.due);
  return `Due ${absolute ? fmtDueAbsolute(due) : fmtDue(due)}${course ? ` · ${course}` : ''}`;
}

const upcoming = (state, now) => state.assignments.filter((a) => !a.done && Date.parse(a.due) > now);

// Marks reminders whose time has already passed as shown, so turning reminders on doesn't set off a burst.
export function primeReminders(state) {
  const now = Date.now();
  for (const a of upcoming(state, now)) {
    for (const o of state.settings.offsets) if (Date.parse(a.due) - o * MIN <= now) state.fired[keyOf(a, o)] = now;
  }
}

// Shows the latest reminder that has come due for each assignment. Earlier ones missed while the app
// was closed are folded into it rather than shown one after another.
export function runLocalReminders(state) {
  const s = state.settings;
  if (!s.notify || !canNotify() || Notification.permission !== 'granted') return false;
  const now = Date.now();
  let changed = runDigest(state);
  for (const a of upcoming(state, now)) {
    const passed = s.offsets.filter((o) => Date.parse(a.due) - o * MIN <= now);
    if (!passed.length || passed.every((o) => state.fired[keyOf(a, o)])) continue;
    notify(a.title, reminderText(state, a, false), a.id);
    for (const o of passed) state.fired[keyOf(a, o)] = now;
    changed = true;
  }
  return changed;
}

// One summary the first time the app runs each day after 7am.
function runDigest(state) {
  const now = new Date();
  const today = now.toDateString();
  if (state.lastDigest === today || now.getHours() < 7) return false;
  state.lastDigest = today;
  const open = state.assignments.filter((a) => !a.done);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const overdue = open.filter((a) => Date.parse(a.due) < now).length;
  const dueToday = open.filter((a) => Date.parse(a.due) >= now && new Date(a.due).toDateString() === today).length;
  const dueTomorrow = open.filter((a) => new Date(a.due).toDateString() === tomorrow.toDateString()).length;
  const parts = [];
  if (dueToday) parts.push(`${dueToday} due today`);
  if (dueTomorrow) parts.push(`${dueTomorrow} due tomorrow`);
  if (overdue) parts.push(`${overdue} overdue`);
  if (parts.length) notify('Today’s plan', parts.join(' · '), 'digest');
  return true;
}

export async function publishNtfy(s, { title, message, at, tags = 'books' }) {
  const params = new URLSearchParams({ title, tags });
  if (at) params.set('at', String(Math.floor(at / 1000)));
  const url = `${s.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(s.ntfyTopic)}?${params}`;
  try {
    // A plain-text body and no custom headers keeps this a simple cross-origin request.
    const res = await fetch(url, { method: 'POST', body: message });
    return res.ok;
  } catch {
    return false;
  }
}

// Hands ntfy every reminder that falls inside its 3-day window and hasn't been sent yet.
export async function scheduleNtfy(state) {
  const s = state.settings;
  if (!s.ntfy || !s.ntfyTopic) return false;
  const now = Date.now();
  let sent = 0;
  const list = upcoming(state, now).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  for (const a of list) {
    for (const o of s.offsets) {
      const at = Date.parse(a.due) - o * MIN;
      const key = keyOf(a, o);
      if (at < now + MIN || at > now + NTFY_MAX_AHEAD || state.scheduled[key]) continue;
      if (sent >= NTFY_BATCH) return true;
      if (!(await publishNtfy(s, { title: a.title, message: reminderText(state, a, true), at }))) return sent > 0;
      state.scheduled[key] = now;
      sent++;
    }
  }
  return sent > 0;
}

export function pruneReminderLog(state) {
  const cutoff = Date.now() - 21 * 24 * 60 * MIN;
  let changed = false;
  for (const log of [state.fired, state.scheduled]) {
    for (const [key, t] of Object.entries(log)) {
      if (t < cutoff) {
        delete log[key];
        changed = true;
      }
    }
  }
  return changed;
}

// ntfy topics work like a password: anyone who knows the name can read it.
export function newTopic() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `planner-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
