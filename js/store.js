// Everything lives in localStorage on this device. Backups move it between devices.

export const STORAGE_KEY = 'study-planner:v1';

// Readable on both light and dark backgrounds.
export const COURSE_COLORS = ['#4c6ef5', '#12b886', '#f59f00', '#e64980', '#7950f2', '#15aabf', '#fa5252', '#82c91e'];

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function defaults() {
  return {
    version: 1,
    courses: [],
    assignments: [],
    settings: {
      notify: false,
      offsets: [4320, 1440, 180], // minutes before due: 3 days, 1 day, 3 hours
      ntfy: false,
      ntfyServer: 'https://ntfy.sh',
      ntfyTopic: '',
    },
    fired: {}, // reminder key -> when it was shown on this device
    scheduled: {}, // reminder key -> when it was handed to ntfy
    lastDigest: '',
    lastSync: null, // { at, from } after a Sync from Brightspace
  };
}

export function normalize(data) {
  const base = defaults();
  return { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : defaults();
  } catch {
    return defaults();
  }
}

export function save(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
