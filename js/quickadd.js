// Turns "Bio lab report fri 11:59pm 2h 15% #bio" into an assignment draft.
import { startOfDay } from './format.js';

const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10,
  november: 10, dec: 11, december: 11,
};
// Words too common to identify a course on their own.
const STOP = new Set(['the', 'and', 'for', 'due', 'read', 'with', 'from', 'into', 'about', 'final', 'test', 'quiz', 'exam', 'essay', 'paper', 'project', 'homework', 'lab']);

const END = '(?=[\\s,.;!?])';
const alternation = (obj) => Object.keys(obj).sort((a, b) => b.length - a.length).join('|');
const re = (src, flags = 'i') => new RegExp(src + END, flags);

const WEIGHT_RE = re('\\s(\\d{1,3}(?:\\.\\d+)?)\\s?%');
const HOURS_RE = re('\\s(\\d+(?:\\.\\d+)?)\\s?(?:h|hrs?|hours?)');
const MINUTES_RE = re('\\s(\\d+)\\s?(?:m|mins?|minutes?)');
const TAG_RE = /\s#([\p{L}\p{N}_-]+)/u;
const TIME_12_RE = re('\\s(?:at\\s+|@\\s*)?(\\d{1,2})(?::([0-5]\\d))?\\s?(am|pm)');
const TIME_24_RE = re('\\s(?:at\\s+|@\\s*)?([01]?\\d|2[0-3]):([0-5]\\d)', '');
const TIME_WORD_RE = re('\\s(?:at\\s+)?(noon|midday|midnight)');
const TODAY_RE = re('\\s(today|tonight)');
const TOMORROW_RE = re('\\s(tomorrow|tmrw|tmr|tmw)');
const IN_DAYS_RE = re('\\sin\\s+(\\d+)\\s+(days?|weeks?)');
const WEEKDAY_RE = re(`\\s(next\\s+|this\\s+)?(${alternation(WEEKDAYS)})`);
const MONTH_DAY_RE = re(`\\s(${alternation(MONTHS)})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`);
const DAY_MONTH_RE = re(`\\s(\\d{1,2})(?:st|nd|rd|th)?\\s+(${alternation(MONTHS)})\\.?(?:\\s+(\\d{4}))?`);
const NUMERIC_DATE_RE = re('\\s(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2}|\\d{4}))?', '');

const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

export function parseQuickAdd(text, courses = [], now = new Date()) {
  let rest = ` ${text} `;
  // Removes the first match from the text so what's left becomes the title.
  const take = (pattern) => {
    const m = rest.match(pattern);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };
  const out = { title: '', due: null, estHours: null, weight: null, courseId: null, newCourse: null };
  let m;

  if ((m = take(WEIGHT_RE))) out.weight = Number(m[1]);
  if ((m = take(HOURS_RE))) out.estHours = Number(m[1]);
  else if ((m = take(MINUTES_RE))) out.estHours = Math.round((Number(m[1]) / 60) * 100) / 100;
  if ((m = take(TAG_RE))) matchTag(m[1], courses, out);

  let time = null;
  if ((m = take(TIME_12_RE))) {
    const hour = Number(m[1]);
    if (hour >= 1 && hour <= 12) time = { h: (hour % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0), m: Number(m[2] || 0) };
  } else if ((m = take(TIME_24_RE))) {
    time = { h: Number(m[1]), m: Number(m[2]) };
  } else if ((m = take(TIME_WORD_RE))) {
    // "Due midnight" means the end of that day, not the start.
    time = m[1].toLowerCase() === 'midnight' ? { h: 23, m: 59 } : { h: 12, m: 0 };
  }

  const today = startOfDay(now);
  const at = (date, t) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), t.h, t.m);
  const plusDays = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d;
  };
  let date = null;
  if (take(TODAY_RE)) date = plusDays(0);
  else if (take(TOMORROW_RE)) date = plusDays(1);
  else if ((m = take(IN_DAYS_RE))) date = plusDays(Number(m[1]) * (/^w/i.test(m[2]) ? 7 : 1));
  else if ((m = take(WEEKDAY_RE))) {
    let diff = (WEEKDAYS[m[2].toLowerCase()] - now.getDay() + 7) % 7;
    if (diff === 0 && time && at(today, time) <= now) diff = 7;
    if (/^next/i.test(m[1] || '')) diff += 7;
    date = plusDays(diff);
  } else if ((m = take(MONTH_DAY_RE))) date = calendarDate(MONTHS[m[1].toLowerCase()], Number(m[2]), m[3], today);
  else if ((m = take(DAY_MONTH_RE))) date = calendarDate(MONTHS[m[2].toLowerCase()], Number(m[1]), m[3], today);
  else if ((m = take(NUMERIC_DATE_RE))) date = calendarDate(Number(m[1]) - 1, Number(m[2]), m[3], today);

  // A time on its own means the next time that clock time comes round.
  if (!date && time) date = at(today, time) <= now ? plusDays(1) : plusDays(0);
  if (date) out.due = at(date, time || { h: 23, m: 59 });

  out.title = cleanTitle(rest);
  if (!out.courseId && !out.newCourse) out.courseId = guessCourse(out.title, courses);
  return out;
}

function calendarDate(month, day, year, today) {
  const y = year ? Number(year.length === 2 ? `20${year}` : year) : today.getFullYear();
  const date = new Date(y, month, day);
  if (date.getMonth() !== month || date.getDate() !== day) return null;
  // "jan 10" typed in December means next January.
  if (!year && date < today - 60 * 86_400_000) date.setFullYear(y + 1);
  return date;
}

function cleanTitle(rest) {
  let title = rest.replace(/\s+([,;])/g, '$1').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = title;
    title = title.replace(/^due\s+/i, '').replace(/[\s,;:–—-]+(?:due|by|at|on|before)?$/i, '').trim();
  } while (title !== prev);
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function matchTag(tag, courses, out) {
  const t = tag.toLowerCase();
  const course = courses.find((c) => {
    const parts = words(c.name);
    return parts.join('').startsWith(t) || parts.some((p) => p.startsWith(t));
  });
  if (course) out.courseId = course.id;
  else out.newCourse = tag.charAt(0).toUpperCase() + tag.slice(1);
}

// "bio" finds "Biology"; "bio101" finds "BIO 101". Only the first word of a course name matches a 3-letter prefix.
function guessCourse(title, courses) {
  const candidates = words(title).filter((w) => w.length >= 3 && !STOP.has(w));
  for (const c of courses) {
    const parts = words(c.name);
    const compact = parts.join('');
    if (candidates.some((w) => w === compact || parts.some((p, i) => p.startsWith(w) && (i === 0 || w.length >= 4)))) return c.id;
  }
  return null;
}
