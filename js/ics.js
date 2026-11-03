// Reads the calendar files Moodle, Blackboard and Brightspace export (.ics) into deadline items.

// "Quiz 3 opens" is not a deadline.
const SKIP = /\b(opens|is available|availability starts|starts|begins)$/i;
// "Essay 1 is due", "Quiz 3 - Availability Ends", "Lab 2 closes" -> the bare name.
const DUE_SUFFIX = /\s*(?:[-–:]\s*)?(?:is due|due|closes|availability ends)$/i;

export function parseIcs(text) {
  if (!/BEGIN:VCALENDAR/i.test(text)) return null;

  // Long lines are folded onto continuation lines that start with a space or tab.
  const lines = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }

  const items = [];
  let cur = null;
  let inAlarm = false;
  for (const line of lines) {
    if (/^BEGIN:VALARM$/i.test(line)) inAlarm = true;
    else if (/^END:VALARM$/i.test(line)) inAlarm = false;
    else if (/^BEGIN:(VEVENT|VTODO)$/i.test(line)) cur = {};
    else if (/^END:(VEVENT|VTODO)$/i.test(line)) {
      if (cur) items.push(toItem(cur));
      cur = null;
    } else if (cur && !inAlarm) {
      const prop = splitProp(line);
      if (prop && !(prop.name in cur)) cur[prop.name] = prop;
    }
  }
  return items;
}

function toItem(props) {
  const summary = unescape(props.SUMMARY?.value || '').trim() || 'Untitled';
  const when = props.DUE || props.DTSTART || props.DTEND;
  const location = unescape(props.LOCATION?.value || '').trim();
  return {
    uid: props.UID?.value.trim() || `${summary}|${when?.value || ''}`,
    title: summary.replace(DUE_SUFFIX, '').trim() || summary,
    due: when ? parseDate(when) : null,
    course: firstCategory(props.CATEGORIES) || (location && !/^https?:/i.test(location) ? location : null),
    notes: cleanDescription(props.DESCRIPTION?.value),
    skip: SKIP.test(summary),
  };
}

// NAME;PARAM=x;PARAM="y:z":value — the first colon outside quotes ends the name and params.
function splitProp(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      const [name, ...rawParams] = line.slice(0, i).split(';');
      const params = {};
      for (const p of rawParams) {
        const eq = p.indexOf('=');
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
      }
      return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
    }
  }
  return null;
}

function unescape(value) {
  return value.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function firstCategory(prop) {
  if (!prop) return null;
  return unescape(prop.value.split(',')[0]).trim() || null;
}

function cleanDescription(value) {
  if (!value) return '';
  return unescape(value)
    .replace(/<\/?(?:p|div|br|li|ul|ol|h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 500);
}

function parseDate(prop) {
  const v = prop.value.trim();
  // All-day dates count as due at the end of that day.
  const day = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (day) return new Date(+day[1], day[2] - 1, +day[3], 23, 59);
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)];
  if (m[7]) return new Date(Date.UTC(y, mo, d, h, mi, s));
  if (prop.params.TZID) {
    try {
      return zonedToDate(y, mo, d, h, mi, s, prop.params.TZID);
    } catch {
      // Unknown zone names (some exporters use Windows names) fall through to local time.
    }
  }
  return new Date(y, mo, d, h, mi, s);
}

function zonedToDate(y, mo, d, h, mi, s, timeZone) {
  const wall = Date.UTC(y, mo, d, h, mi, s);
  const first = wall - zoneOffset(wall, timeZone);
  // A second pass corrects times that sit next to a daylight-saving change.
  return new Date(wall - zoneOffset(first, timeZone));
}

function zoneOffset(ts, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ts;
}
