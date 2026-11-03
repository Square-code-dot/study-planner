// Study Planner: assignments, reminders and grades, stored on this device.
import { STORAGE_KEY, COURSE_COLORS, defaults, load, normalize, save, uid } from './store.js';
import { parseQuickAdd } from './quickadd.js';
import { parseIcs } from './ics.js';
import { bookmarkletHref } from './brightspace.js';
import { categoryPercent, courseGrade, droppedItems, letterGrade, neededOnFinal } from './grades.js';
import {
  OFFSET_OPTIONS, canNotify, newTopic, notify, primeReminders, publishNtfy, pruneReminderLog, requestPermission,
  runLocalReminders, scheduleNtfy,
} from './reminders.js';
import {
  escapeHtml as esc, dayDiff, fmtDate, fmtDue, fmtHours, fmtRelative, fmtTime, fmtWeekdayNarrow, startOfDay, toLocalInput,
} from './format.js';

const TABS = ['upcoming', 'grades', 'settings'];
const GROUPS = [['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['later', 'Later']];
const QA_HINT = 'Try “Essay draft nov 14 5pm 3h 20% #english”';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

let state = load();
let tab = tabFromHash();
let openCourseId = null;
let showDone = false;
let lastImport = '';

// ---------- State helpers ----------

function tabFromHash() {
  const t = location.hash.slice(1);
  return TABS.includes(t) ? t : 'upcoming';
}

function commit(rerender = true) {
  if (!save(state)) toast('Couldn’t save. Browser storage may be full or blocked.');
  if (rerender) render();
}

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(state), 300);
}

function num(value) {
  const n = parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const courseById = (id) => state.courses.find((c) => c.id === id) || null;
const assignmentById = (id) => state.assignments.find((a) => a.id === id) || null;
const byDue = (a, b) => Date.parse(a.due) - Date.parse(b.due);

function ensureCourse(name) {
  const clean = name.trim();
  const existing = state.courses.find((c) => c.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const course = {
    id: uid('c'), name: clean, color: COURSE_COLORS[state.courses.length % COURSE_COLORS.length],
    categories: [], target: 90, finalWeight: null,
  };
  state.courses.push(course);
  return course;
}

function newAssignment(fields) {
  return {
    id: uid('a'), title: '', courseId: null, due: null, estHours: null, weight: null, notes: '',
    done: false, doneAt: null, source: 'manual', uid: null, edited: false, createdAt: Date.now(), ...fields,
  };
}

function defaultDue() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(23, 59, 0, 0);
  return d;
}

// ---------- Toast ----------

let toastTimer;
function toast(message, action) {
  toastEl.innerHTML = `<span>${esc(message)}</span>${action ? `<button class="toast-btn" type="button">${esc(action.label)}</button>` : ''}`;
  if (action) {
    toastEl.querySelector('button').onclick = () => {
      action.run();
      toastEl.classList.remove('show');
    };
  }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), action ? 6000 : 3500);
}

// ---------- Rendering ----------

function render() {
  document.querySelectorAll('.tab').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  // Keep whatever is half-typed in quick add across re-renders.
  const qa = document.getElementById('qa');
  const kept = qa ? { value: qa.value, focused: document.activeElement === qa } : null;
  view.innerHTML = tab === 'grades' ? renderGrades() : tab === 'settings' ? renderSettings() : renderUpcoming();
  const next = document.getElementById('qa');
  if (kept && next) {
    next.value = kept.value;
    updatePreview();
    if (kept.focused) next.focus();
  }
}

function refreshRelative() {
  const now = new Date();
  view.querySelectorAll('[data-due]').forEach((el) => {
    el.textContent = fmtRelative(new Date(el.dataset.due), now);
  });
}

// ---------- Upcoming ----------

function bucketOf(a, now) {
  const due = new Date(a.due);
  if (due < now) return 'overdue';
  const diff = dayDiff(due, now);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return diff < 7 ? 'week' : 'later';
}

function renderUpcoming() {
  const now = new Date();
  const open = state.assignments.filter((a) => !a.done).sort(byDue);
  const done = state.assignments.filter((a) => a.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  if (!state.assignments.length) {
    return `${quickAddHtml()}
      <div class="card empty">
        <p class="empty-title">Let’s get your deadlines in</p>
        <p class="muted">Import the calendar file from Moodle, Blackboard or Brightspace, or type an assignment above.</p>
        <div class="btn-row"><button class="btn primary" type="button" data-action="go-settings">Import calendar</button></div>
      </div>`;
  }

  const groups = Object.fromEntries(GROUPS.map(([key]) => [key, []]));
  for (const a of open) groups[bucketOf(a, now)].push(a);
  const lists = GROUPS.filter(([key]) => groups[key].length).map(([key, label]) => `
    <section class="group group-${key}">
      <h2 class="group-title">${label}<span class="count">${groups[key].length}</span></h2>
      <ul class="rows">${groups[key].map((a) => rowHtml(a, now)).join('')}</ul>
    </section>`).join('');

  const doneList = done.length ? `
    <section class="group group-done">
      <button class="group-title group-toggle" type="button" data-action="toggle-done-list" aria-expanded="${showDone}">
        Done<span class="count">${done.length}</span>${ICON_CHEVRON}
      </button>
      ${showDone ? `<ul class="rows">${done.slice(0, 40).map((a) => rowHtml(a, now)).join('')}</ul>` : ''}
    </section>` : '';

  const caughtUp = open.length ? '' : `
    <div class="card empty">
      <p class="empty-title">All caught up</p>
      <p class="muted">Nothing left to do. Add the next one above when it comes in.</p>
    </div>`;

  return quickAddHtml() + (open.length ? overviewHtml(open, now) : caughtUp) + lists + doneList;
}

function quickAddHtml() {
  return `
    <section class="card qa">
      <form id="qa-form" class="qa-form" autocomplete="off">
        <label class="sr-only" for="qa">Add an assignment</label>
        <input id="qa" type="text" placeholder="Bio lab report fri 11:59pm 2h" enterkeyhint="done" autocapitalize="sentences" spellcheck="false">
        <button class="btn primary" type="submit">Add</button>
      </form>
      <div class="qa-foot">
        <p id="qa-preview" class="qa-preview muted">${esc(QA_HINT)}</p>
        <button class="link-btn" type="button" data-action="new">Add with details</button>
      </div>
    </section>`;
}

function updatePreview() {
  const input = document.getElementById('qa');
  const out = document.getElementById('qa-preview');
  if (!input || !out) return;
  const text = input.value.trim();
  out.classList.toggle('muted', !text);
  if (!text) {
    out.textContent = QA_HINT;
    return;
  }
  const p = parseQuickAdd(text, state.courses);
  const bits = [`<strong>${esc(p.title || 'Untitled')}</strong>`];
  bits.push(p.due ? esc(fmtDue(p.due)) : '<span class="warn">add a day, like “fri” or “nov 14”</span>');
  const course = courseById(p.courseId);
  if (course) bits.push(`<span class="chip" style="--c:${course.color}">${esc(course.name)}</span>`);
  if (p.newCourse) bits.push(`<span class="chip">${esc(p.newCourse)} (new course)</span>`);
  if (p.estHours) bits.push(fmtHours(p.estHours));
  if (p.weight) bits.push(`${p.weight}% of grade`);
  out.innerHTML = bits.join('<span class="dot" aria-hidden="true">·</span>');
}

function quickAddDraft() {
  const text = document.getElementById('qa')?.value.trim();
  return text ? parseQuickAdd(text, state.courses) : {};
}

function addFromQuickAdd() {
  const input = document.getElementById('qa');
  const text = input.value.trim();
  if (!text) return;
  const p = parseQuickAdd(text, state.courses);
  // Missing pieces get filled in on the full form.
  if (!p.title || !p.due) {
    openEditor(null, p);
    return;
  }
  const courseId = p.courseId || (p.newCourse ? ensureCourse(p.newCourse).id : null);
  state.assignments.push(newAssignment({ title: p.title, due: p.due.toISOString(), courseId, estHours: p.estHours, weight: p.weight }));
  input.value = '';
  commit();
  toast(`Added “${p.title}”`);
}

function overviewHtml(open, now) {
  const weekEnd = now.getTime() + 7 * 86_400_000;
  const overdue = open.filter((a) => Date.parse(a.due) < now).length;
  const today = open.filter((a) => bucketOf(a, now) === 'today').length;
  const week = open.filter((a) => Date.parse(a.due) >= now && Date.parse(a.due) < weekEnd);
  const weekHours = week.reduce((sum, a) => sum + (a.estHours || 1), 0);

  const days = Array.from({ length: 14 }, (_, i) => {
    const d = startOfDay(now);
    d.setDate(d.getDate() + i);
    return { d, hours: 0, count: 0 };
  });
  for (const a of open) {
    const i = dayDiff(new Date(a.due), now);
    if (i >= 0 && i < 14 && Date.parse(a.due) >= now) {
      days[i].hours += a.estHours || 1;
      days[i].count++;
    }
  }
  const max = Math.max(4, ...days.map((x) => x.hours));

  return `
    <section class="card overview">
      <div class="stats">
        <div class="stat${overdue ? ' is-danger' : ''}"><span class="stat-num">${overdue}</span><span class="stat-label">Overdue</span></div>
        <div class="stat"><span class="stat-num">${today}</span><span class="stat-label">Due today</span></div>
        <div class="stat"><span class="stat-num">${week.length}</span><span class="stat-label">Next 7 days · ~${fmtHours(weekHours)}</span></div>
      </div>
      <div class="strip" role="img" aria-label="Workload for the next 14 days">
        ${days.map((x, i) => {
          const weekend = x.d.getDay() === 0 || x.d.getDay() === 6;
          const cls = ['day', i === 0 && 'is-today', weekend && 'is-weekend', x.hours >= 5 && 'is-heavy'].filter(Boolean).join(' ');
          const height = x.hours ? Math.max(10, (x.hours / max) * 100) : 0;
          return `<div class="${cls}" title="${esc(fmtDate(x.d))}: ${x.count} due, ~${fmtHours(x.hours)} of work">
            <div class="bar-wrap"><div class="bar" style="height:${height}%"></div></div>
            <span class="day-label">${fmtWeekdayNarrow(x.d)}<b>${x.d.getDate()}</b></span>
          </div>`;
        }).join('')}
      </div>
      <p class="small muted">Work by due date over the next two weeks. Items without an estimate count as 1h.</p>
    </section>`;
}

function rowHtml(a, now) {
  const due = new Date(a.due);
  const course = courseById(a.courseId);
  const overdue = !a.done && due < now;
  const meta = [];
  if (course) meta.push(`<span class="chip" style="--c:${course.color}">${esc(course.name)}</span>`);
  meta.push(`<span>${esc(fmtDue(due, now))}</span>`);
  if (a.estHours) meta.push(`<span>${fmtHours(a.estHours)}</span>`);
  if (a.weight) meta.push(`<span>${a.weight}%</span>`);
  const start = a.done ? '' : startHint(a, due, now);
  if (start) meta.push(`<span class="start">${esc(start)}</span>`);
  return `
    <li class="row${a.done ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}" data-id="${a.id}">
      <button class="check" type="button" data-action="toggle" aria-pressed="${a.done}" aria-label="${a.done ? 'Mark not done' : 'Mark done'}: ${esc(a.title)}">
        <span class="check-box">${ICON_CHECK}</span>
      </button>
      <button class="row-main" type="button" data-action="edit">
        <span class="row-title">${esc(a.title)}</span>
        <span class="row-meta">${meta.join('<span class="dot" aria-hidden="true">·</span>')}</span>
      </button>
      ${a.done ? '' : `<span class="row-rel" data-due="${a.due}">${fmtRelative(due, now)}</span>`}
    </li>`;
}

// A rough "when to begin" nudge, assuming about two focused hours a day.
function startHint(a, due, now) {
  if (!a.estHours || a.estHours < 2 || due < now) return '';
  const start = new Date(due);
  start.setDate(start.getDate() - Math.ceil(a.estHours / 2));
  if (start <= now) return 'Start now';
  const diff = dayDiff(start, now);
  if (diff === 0) return 'Start today';
  return diff < 7 ? `Start by ${start.toLocaleDateString([], { weekday: 'short' })}` : '';
}

function toggleDone(id) {
  const a = assignmentById(id);
  if (!a) return;
  a.done = !a.done;
  a.doneAt = a.done ? Date.now() : null;
  commit();
  if (a.done) {
    toast(`Done: ${a.title}`, {
      label: 'Undo',
      run: () => {
        a.done = false;
        a.doneAt = null;
        commit();
      },
    });
  }
}

// ---------- Assignment editor ----------

function courseOptions(selectedId, pendingName = '') {
  return `<option value="">No course</option>${
    state.courses.map((c) => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
  }${pendingName ? `<option value="__new:${esc(pendingName)}" selected>${esc(pendingName)} (new)</option>` : ''
  }<option value="__add">+ New course…</option>`;
}

function openEditor(id, prefill = {}) {
  const a = id ? assignmentById(id) : null;
  if (id && !a) return;
  const v = a || {
    title: prefill.title || '', courseId: prefill.courseId || null, due: (prefill.due || defaultDue()).toISOString(),
    estHours: prefill.estHours ?? null, weight: prefill.weight ?? null, notes: '',
  };
  sheet.dataset.id = a ? a.id : '';
  sheet.innerHTML = `
    <form method="dialog" class="sheet-body">
      <header class="sheet-head">
        <h2>${a ? 'Edit assignment' : 'New assignment'}</h2>
        <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Close">×</button>
      </header>
      <label class="field"><span>Title</span><input type="text" name="title" required value="${esc(v.title)}" autocapitalize="sentences"></label>
      <label class="field"><span>Course</span><select name="courseId">${courseOptions(v.courseId, a ? '' : prefill.newCourse)}</select></label>
      <label class="field"><span>Due</span><input type="datetime-local" name="due" required value="${toLocalInput(new Date(v.due))}"></label>
      <div class="field-row">
        <label class="field"><span>Hours of work</span><input type="text" name="estHours" inputmode="decimal" value="${v.estHours ?? ''}" placeholder="e.g. 2"></label>
        <label class="field"><span>% of grade</span><input type="text" name="weight" inputmode="decimal" value="${v.weight ?? ''}" placeholder="e.g. 15"></label>
      </div>
      <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(v.notes)}</textarea></label>
      ${a?.source === 'ics' ? '<p class="small muted">Imported from your portal calendar. Once you edit it here, re-importing won’t overwrite your changes.</p>' : ''}
      <footer class="sheet-foot">
        ${a ? '<button type="button" class="btn danger-ghost" data-action="delete">Delete</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-action="close-sheet">Cancel</button>
        <button type="submit" class="btn primary" value="save">Save</button>
      </footer>
    </form>`;
  sheet.showModal();
}

function deleteAssignment(id) {
  const i = state.assignments.findIndex((a) => a.id === id);
  if (i < 0) return;
  const [removed] = state.assignments.splice(i, 1);
  sheet.close();
  commit();
  toast(`Deleted “${removed.title}”`, {
    label: 'Undo',
    run: () => {
      state.assignments.splice(i, 0, removed);
      commit();
    },
  });
}

sheet.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const f = new FormData(e.target);
  const title = String(f.get('title')).trim();
  const due = new Date(String(f.get('due')));
  if (!title || Number.isNaN(due.getTime())) {
    e.preventDefault();
    toast('Add a title and a due date.');
    return;
  }
  let courseId = f.get('courseId') || null;
  if (courseId === '__add') courseId = null;
  if (courseId?.startsWith('__new:')) courseId = ensureCourse(courseId.slice(6)).id;
  const fields = {
    title, courseId, due: due.toISOString(), estHours: num(f.get('estHours')), weight: num(f.get('weight')),
    notes: String(f.get('notes')).trim(),
  };
  const existing = assignmentById(sheet.dataset.id);
  if (existing) Object.assign(existing, fields, { edited: true });
  else {
    state.assignments.push(newAssignment(fields));
    const qa = document.getElementById('qa');
    if (qa) qa.value = '';
  }
  commit();
});

sheet.addEventListener('click', (e) => {
  if (e.target === sheet) return sheet.close(); // backdrop
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'close-sheet') sheet.close();
  if (action === 'delete') deleteAssignment(sheet.dataset.id);
});

sheet.addEventListener('change', (e) => {
  const select = e.target;
  if (select.name !== 'courseId' || select.value !== '__add') return;
  const name = prompt('New course name');
  if (name && name.trim()) {
    const course = ensureCourse(name);
    commit(false);
    select.innerHTML = courseOptions(course.id);
  } else {
    select.value = '';
  }
});

// ---------- Grades ----------

function renderGrades() {
  return `
    <section class="section-head">
      <h2>Grades</h2>
      <button class="btn" type="button" data-action="add-course">Add course</button>
    </section>
    ${state.courses.length ? state.courses.map(courseCardHtml).join('') : `
      <div class="card empty">
        <p class="empty-title">No courses yet</p>
        <p class="muted">Add a course, then enter the grading weights from its syllabus and your scores. Importing your calendar also creates courses.</p>
      </div>`}`;
}

function gradeText(g) {
  return g ? `${g.percent.toFixed(1)}%<span class="letter">${letterGrade(g.percent)}</span>` : '<span class="muted">No scores yet</span>';
}

function weightsText(c) {
  const total = c.categories.reduce((sum, cat) => sum + (cat.weight || 0), 0);
  if (!c.categories.length) return '';
  return Math.abs(total - 100) < 0.01 ? 'Weights add up to 100%' : `<span class="is-warn">Weights add up to ${Math.round(total * 10) / 10}%, not 100%</span>`;
}

function suggestedFinalWeight(c) {
  return c.categories.find((cat) => /final/i.test(cat.name))?.weight || 25;
}

function needText(c, g) {
  const target = c.target ?? 90;
  const w = c.finalWeight ?? suggestedFinalWeight(c);
  if (!g) return 'Enter some scores first.';
  if (!(w > 0 && w < 100)) return 'Enter how much the final is worth, between 1 and 99%.';
  const need = neededOnFinal(g.percent, target, w);
  if (need <= 0) return `You’ll finish at ${target}% or better even with a 0 on the final.`;
  if (need > 100) {
    const best = g.percent * (1 - w / 100) + w;
    return `Out of reach: even 100% on the final gets you ${best.toFixed(1)}% (${letterGrade(best)}).`;
  }
  return `You need <strong>${need.toFixed(1)}%</strong> on the final to finish with ${target}% (${letterGrade(target)}).`;
}

function courseCardHtml(c) {
  const g = courseGrade(c);
  const open = openCourseId === c.id;
  return `
    <article class="card course${open ? ' is-open' : ''}" data-course="${c.id}" style="--c:${c.color}">
      <button class="course-head" type="button" data-action="open-course" aria-expanded="${open}">
        <span class="course-dot" aria-hidden="true"></span>
        <span class="course-name">${esc(c.name)}</span>
        <span class="course-grade" data-out="grade">${gradeText(g)}</span>
        ${ICON_CHEVRON}
      </button>
      ${open ? courseDetailHtml(c, g) : ''}
    </article>`;
}

function courseDetailHtml(c, g) {
  return `
    <div class="course-body">
      <label class="field"><span>Course name</span><input type="text" data-field="course-name" value="${esc(c.name)}"></label>
      <div class="swatches" role="radiogroup" aria-label="Course color">
        ${COURSE_COLORS.map((col) => `<button type="button" class="swatch" role="radio" aria-checked="${col === c.color}" aria-label="Color ${col}" data-action="color" data-color="${col}" style="--c:${col}"></button>`).join('')}
      </div>
      ${c.portalGrade ? `<p class="small muted">Brightspace shows ${c.portalGrade.percent.toFixed(1)}%${c.portalGrade.label ? ` (${esc(c.portalGrade.label)})` : ''}${c.portalGrade.at ? ` as of ${esc(fmtDate(new Date(c.portalGrade.at)))}` : ''}.</p>` : ''}
      <h3 class="sub">Grading categories <span class="muted" data-out="weights">${weightsText(c)}</span></h3>
      <div class="cats">
        ${c.categories.length ? c.categories.map(categoryHtml).join('') : '<p class="small muted">Copy the categories from your syllabus, like Homework 20% or Final exam 30%.</p>'}
      </div>
      <button class="btn add-cat" type="button" data-action="add-cat">Add category</button>
      <div class="final">
        <h3 class="sub">What do I need on the final?</h3>
        <div class="field-row">
          <label class="field"><span>Grade I want (%)</span><input type="text" inputmode="decimal" data-field="target" value="${c.target ?? 90}"></label>
          <label class="field"><span>Final is worth (%)</span><input type="text" inputmode="decimal" data-field="final-weight" value="${c.finalWeight ?? suggestedFinalWeight(c)}"></label>
        </div>
        <p class="final-out" data-out="need">${needText(c, g)}</p>
      </div>
      <div class="course-foot"><button class="btn danger-ghost" type="button" data-action="del-course">Delete course</button></div>
    </div>`;
}

function categoryHtml(cat) {
  const pct = categoryPercent(cat);
  const dropped = droppedItems(cat);
  return `
    <div class="cat" data-cat="${cat.id}">
      <div class="cat-head">
        <input type="text" class="cat-name" data-field="cat-name" value="${esc(cat.name)}" placeholder="Category" aria-label="Category name">
        <label class="weight"><input type="text" inputmode="decimal" data-field="cat-weight" value="${cat.weight ?? ''}" placeholder="0" aria-label="Weight in percent"><span>%</span></label>
        <span class="cat-pct" data-out="cat">${pct === null ? '–' : `${pct.toFixed(1)}%`}</span>
        <button class="icon-btn" type="button" data-action="del-cat" aria-label="Delete category">×</button>
      </div>
      <ul class="items">
        ${cat.items.map((it) => `
          <li class="item${dropped.has(it) ? ' is-dropped' : ''}" data-item="${it.id}">
            <input type="text" data-field="item-name" value="${esc(it.name)}" placeholder="Name" aria-label="Score name">
            <input type="text" inputmode="decimal" data-field="item-score" value="${it.score ?? ''}" placeholder="Score" aria-label="Points earned">
            <span class="of" aria-hidden="true">/</span>
            <input type="text" inputmode="decimal" data-field="item-max" value="${it.max ?? ''}" placeholder="Out of" aria-label="Points possible">
            <button class="icon-btn" type="button" data-action="del-item" aria-label="Delete score">×</button>
          </li>`).join('')}
      </ul>
      <div class="cat-foot">
        <button class="link-btn" type="button" data-action="add-item">+ Add score</button>
        <label class="drop"><span>Drop lowest</span><input type="text" inputmode="numeric" data-field="cat-drop" value="${cat.dropLowest || ''}" placeholder="0" aria-label="Number of lowest scores to drop"></label>
      </div>
    </div>`;
}

// Updates the computed numbers in place so typing never loses focus.
function refreshCourse(card, c) {
  const g = courseGrade(c);
  card.querySelector('[data-out="grade"]').innerHTML = gradeText(g);
  card.querySelector('.course-name').textContent = c.name;
  card.querySelector('[data-out="weights"]').innerHTML = weightsText(c);
  card.querySelector('[data-out="need"]').innerHTML = needText(c, g);
  for (const el of card.querySelectorAll('[data-cat]')) {
    const cat = c.categories.find((x) => x.id === el.dataset.cat);
    const pct = categoryPercent(cat);
    el.querySelector('[data-out="cat"]').textContent = pct === null ? '–' : `${pct.toFixed(1)}%`;
    const dropped = new Set([...droppedItems(cat)].map((it) => it.id));
    for (const li of el.querySelectorAll('[data-item]')) li.classList.toggle('is-dropped', dropped.has(li.dataset.item));
  }
}

function focusField(selector) {
  view.querySelector(selector)?.focus();
}

function addCourse() {
  const name = prompt('Course name, for example "BIO 101"');
  if (!name || !name.trim()) return;
  openCourseId = ensureCourse(name).id;
  commit();
}

// ---------- Settings ----------

function renderSettings() {
  const s = state.settings;
  const perm = canNotify() ? Notification.permission : 'unsupported';
  const permText = {
    granted: 'Allowed in this browser',
    denied: 'Blocked. Allow notifications in this site’s browser settings.',
    default: 'Your browser will ask for permission',
    unsupported: 'Not supported in this browser',
  }[perm];
  return `
    <section class="card stack">
      <h2 class="card-title">Import from your portal</h2>
      <p class="muted">Export your calendar from Moodle, Blackboard or Brightspace as an <code>.ics</code> file, then choose it here. A Study Planner import file (<code>.json</code>) works too. Import again any time: dates update and nothing is duplicated.</p>
      <label class="btn primary file-btn">Choose file<input type="file" accept=".ics,text/calendar,.json,application/json" data-field="ics-file" hidden></label>
      ${lastImport ? `<p class="note">${esc(lastImport)}</p>` : ''}
      <details class="help">
        <summary>Where do I find the calendar file?</summary>
        <dl>
          <dt>Moodle</dt>
          <dd>Open <b>Calendar</b>, then <b>Import or export calendars</b> → <b>Export calendar</b>. Choose “All courses” and a range like “Recent and next 60 days”, then <b>Export</b>.</dd>
          <dt>Blackboard</dt>
          <dd>Open <b>Calendar</b> and look for <b>Share calendar</b> in the calendar settings (Ultra) or <b>Get External Calendar Link</b> (Original). Open that link in your browser to download the file.</dd>
          <dt>Brightspace (D2L)</dt>
          <dd>Open <b>Calendar</b> → <b>Subscribe</b>, choose all courses, and open the link to download the file.</dd>
        </dl>
        <p class="small muted">Menu names vary a little between schools. If a link starts with <code>webcal://</code>, change it to <code>https://</code>. Keep the link private: anyone who has it can see your schedule.</p>
      </details>
    </section>

    <section class="card stack">
      <h2 class="card-title">Sync from Brightspace</h2>
      <p class="muted">A bookmark button that copies your courses, due dates and released grades from Brightspace into this app. It only reads, and it runs in your own browser, so your data goes nowhere else. Works on a laptop.</p>
      <ol class="steps">
        <li>Show your bookmarks bar: <b>Ctrl+Shift+B</b> (<b>Cmd+Shift+B</b> on a Mac).</li>
        <li>Drag this button onto the bar: <a class="btn primary bookmarklet" href="${bookmarkletHref(location.origin + location.pathname)}" data-action="bookmarklet">Sync from Brightspace</a></li>
        <li>Sign in to Brightspace and click the bookmark. This app opens in a new tab and asks before adding anything.</li>
      </ol>
      ${state.lastSync ? `<p class="note">Last synced ${esc(fmtDate(new Date(state.lastSync.at)))} at ${esc(fmtTime(new Date(state.lastSync.at)))} from ${esc(state.lastSync.from)}.</p>` : ''}
      <p class="small muted">The button opens this copy of the app (${esc(location.host)}). If the app moves to a new address, drag a new button from there.</p>
    </section>

    <section class="card stack">
      <h2 class="card-title">Reminders</h2>
      <label class="switch-row">
        <span><b>Notifications on this device</b><small class="muted">${permText}</small></span>
        <input type="checkbox" class="switch" data-field="notify"${s.notify && perm === 'granted' ? ' checked' : ''}${perm === 'unsupported' ? ' disabled' : ''}>
      </label>
      <fieldset class="offsets">
        <legend>Remind me before each due date</legend>
        <div class="chips">
          ${OFFSET_OPTIONS.map(([minutes, label]) => `<label class="chip-toggle"><input type="checkbox" data-field="offset" value="${minutes}"${s.offsets.includes(minutes) ? ' checked' : ''}><span>${label}</span></label>`).join('')}
        </div>
      </fieldset>
      <p class="small muted">On a laptop, reminders appear while the app is open, even in the background. You also get a short summary each morning. For your phone, turn on phone push below.</p>
      <button class="btn" type="button" data-action="test-notify">Send a test notification</button>
    </section>

    <section class="card stack">
      <h2 class="card-title">Phone push with ntfy <span class="badge">Optional</span></h2>
      <p class="muted">ntfy is a free notification app. When this is on, the app schedules your reminders on the ntfy server, so they reach your phone even when this app is closed.</p>
      <ol class="steps">
        <li>Install <b>ntfy</b> from the App Store or Google Play.</li>
        <li>In ntfy, tap <b>+</b> and subscribe to your topic below.</li>
        <li>Turn on phone push, then send a test.</li>
      </ol>
      <div class="field">
        <label for="ntfy-topic">Your private topic</label>
        <div class="input-group">
          <input type="text" id="ntfy-topic" data-field="ntfy-topic" value="${esc(s.ntfyTopic)}" spellcheck="false" autocapitalize="none" autocorrect="off">
          <button class="btn" type="button" data-action="new-topic">New</button>
        </div>
      </div>
      <label class="switch-row">
        <span><b>Phone push</b><small class="muted">Sends assignment titles and due times to ntfy</small></span>
        <input type="checkbox" class="switch" data-field="ntfy"${s.ntfy ? ' checked' : ''}>
      </label>
      <button class="btn" type="button" data-action="test-ntfy"${s.ntfyTopic ? '' : ' disabled'}>Send a test to my phone</button>
      <details class="help">
        <summary>Privacy and limits</summary>
        <p class="small muted">Anyone who knows a topic name on ntfy.sh can read it, so keep yours long and random. Reminders are scheduled up to 3 days ahead each time you open the app, so open it every couple of days. A reminder that is already scheduled still arrives if you finish the assignment early.</p>
        <label class="field"><span>Server</span><input type="text" data-field="ntfy-server" value="${esc(s.ntfyServer)}" spellcheck="false" autocapitalize="none" autocorrect="off"></label>
      </details>
    </section>

    <section class="card stack">
      <h2 class="card-title">Install on your devices</h2>
      <ul class="plain">
        <li><b>Laptop (Chrome or Edge):</b> click the install icon at the right end of the address bar.</li>
        <li><b>iPhone:</b> in Safari, tap Share → Add to Home Screen.</li>
        <li><b>Android:</b> in Chrome, tap ⋮ → Install app.</li>
      </ul>
      <p class="small muted">Each device keeps its own copy of your data. Use a backup to move it from one to the other.</p>
    </section>

    <section class="card stack">
      <h2 class="card-title">Backup</h2>
      <div class="btn-row">
        <button class="btn" type="button" data-action="export">Export backup</button>
        <label class="btn file-btn">Restore backup<input type="file" accept="application/json,.json" data-field="backup-file" hidden></label>
        <button class="btn danger-ghost" type="button" data-action="delete-all">Delete all data</button>
      </div>
    </section>`;
}

function importIcs(text) {
  const items = parseIcs(text);
  if (!items) {
    lastImport = 'That file doesn’t look like a calendar (.ics) file.';
    render();
    return;
  }
  const now = Date.now();
  let added = 0;
  let updated = 0;
  let past = 0;
  let skipped = 0;
  for (const it of items) {
    if (it.skip || !it.due) {
      skipped++;
      continue;
    }
    const existing = state.assignments.find((a) => a.uid && a.uid === it.uid);
    if (existing) {
      const due = it.due.toISOString();
      if (!existing.edited && (existing.due !== due || existing.title !== it.title)) {
        Object.assign(existing, { due, title: it.title });
        updated++;
      }
      continue;
    }
    if (it.due.getTime() < now) {
      past++;
      continue;
    }
    state.assignments.push(newAssignment({
      title: it.title, due: it.due.toISOString(), courseId: it.course ? ensureCourse(it.course).id : null,
      notes: it.notes, source: 'ics', uid: it.uid,
    }));
    added++;
  }
  const parts = [`${added} new`, `${updated} updated`];
  if (past) parts.push(`${past} already past, skipped`);
  if (skipped) parts.push(`${skipped} non-deadline events skipped`);
  lastImport = `Imported: ${parts.join(', ')}.`;
  commit();
  toast(added ? `Added ${added} assignment${added === 1 ? '' : 's'} from your calendar.` : 'Calendar checked. Nothing new to add.');
}

function importFile(text) {
  if (!text.trimStart().startsWith('{')) return importIcs(text);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (data?.kind === 'study-planner-import') return mergeImport(data);
  lastImport = Array.isArray(data?.assignments)
    ? 'That’s a full backup. Use Restore backup at the bottom of this page.'
    : 'That file isn’t a calendar (.ics) or Study Planner import file.';
  render();
}

// An import file (kind "study-planner-import") adds to what's here instead of replacing it, like an .ics import.
// Its grade categories replace that course's categories, because the portal holds the real scores.
// `from` is the site that sent it when it arrives from the Sync from Brightspace button.
function mergeImport(data, from = '') {
  const graded = (data.courses || []).filter((c) => c.categories?.length);
  const ask = [from ? `Add your deadlines and grades from ${from}?` : `Add deadlines from ${data.source || 'this file'}?`];
  if (graded.length) ask.push(`Scores for ${graded.map((c) => courseFor(c)?.name || c.name).join(', ')} will update to match.`);
  if (!confirm(ask.join('\n\n'))) return;

  const courseIds = {};
  for (const c of data.courses || []) {
    // Courses are matched by their portal id first, so renaming one here doesn't make a duplicate.
    const course = courseFor(c) || ensureCourse(c.name);
    if (c.ref) course.ref = c.ref;
    courseIds[c.id] = course.id;
    if (c.portalGrade) course.portalGrade = { ...c.portalGrade, at: data.syncedAt || null };
    if (!c.categories?.length) continue;
    course.categories = c.categories.map((cat) => ({
      ...cat, id: uid('k'), items: (cat.items || []).map((it) => ({ ...it, id: uid('i') })),
    }));
    if (c.finalWeight != null) course.finalWeight = c.finalWeight;
  }

  const now = Date.now();
  let added = 0;
  let updated = 0;
  let past = 0;
  for (const a of data.assignments || []) {
    if (!a.title || !Date.parse(a.due)) continue;
    const existing = state.assignments.find((x) => x.uid && x.uid === a.uid);
    if (existing) {
      let changed = false;
      if (!existing.edited && (existing.due !== a.due || existing.title !== a.title)) {
        Object.assign(existing, { due: a.due, title: a.title });
        changed = true;
      }
      // Handed in on the portal counts as done here; finishing early here is never undone.
      if (a.done && !existing.done) {
        Object.assign(existing, { done: true, doneAt: Date.now() });
        changed = true;
      }
      if (changed) updated++;
      continue;
    }
    if (Date.parse(a.due) < now) {
      past++;
      continue;
    }
    state.assignments.push(newAssignment({
      title: a.title, due: a.due, courseId: courseIds[a.courseId] ?? null, estHours: a.estHours ?? null,
      weight: a.weight ?? null, notes: a.notes || '', source: 'import', uid: a.uid || null,
      done: Boolean(a.done), doneAt: a.done ? Date.now() : null,
    }));
    added++;
  }
  const parts = [`${added} new`, `${updated} updated`];
  if (past) parts.push(`${past} already past, skipped`);
  if (graded.length) parts.push(`grades updated for ${graded.length} course${graded.length === 1 ? '' : 's'}`);
  lastImport = `Imported: ${parts.join(', ')}.`;
  if (from) state.lastSync = { at: Date.now(), from };
  commit();
  toast(from ? `Synced: ${added} new, ${updated} updated.` : 'Import finished.');
}

function courseFor(imported) {
  return (imported.ref && state.courses.find((c) => c.ref === imported.ref))
    || state.courses.find((c) => c.name.toLowerCase() === imported.name.trim().toLowerCase())
    || null;
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `study-planner-backup-${toLocalInput(new Date()).slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function restoreBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (!Array.isArray(data.assignments) || !Array.isArray(data.courses)) throw new Error('not a backup');
  } catch {
    toast('That file isn’t a Study Planner backup.');
    return;
  }
  if (data.kind === 'study-planner-import') return mergeImport(data);
  if (!confirm(`Replace everything on this device with this backup (${data.assignments.length} assignments, ${data.courses.length} courses)?`)) return;
  state = normalize(data);
  commit();
  toast('Backup restored.');
}

// ---------- Events ----------

view.addEventListener('submit', (e) => {
  if (e.target.id !== 'qa-form') return;
  e.preventDefault();
  addFromQuickAdd();
});

view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const rowId = el.closest('[data-id]')?.dataset.id;
  const course = courseById(el.closest('[data-course]')?.dataset.course);
  const cat = course?.categories.find((x) => x.id === el.closest('[data-cat]')?.dataset.cat);
  const s = state.settings;

  switch (el.dataset.action) {
    case 'toggle': return toggleDone(rowId);
    case 'edit': return openEditor(rowId);
    case 'new': return openEditor(null, quickAddDraft());
    case 'toggle-done-list':
      showDone = !showDone;
      return render();
    case 'go-settings':
      location.hash = 'settings';
      return;

    case 'add-course': return addCourse();
    case 'open-course':
      openCourseId = openCourseId === course.id ? null : course.id;
      return render();
    case 'color':
      course.color = el.dataset.color;
      return commit();
    case 'add-cat':
      course.categories.push({ id: uid('k'), name: '', weight: null, items: [] });
      commit();
      return focusField(`[data-course="${course.id}"] .cat:last-child .cat-name`);
    case 'del-cat':
      if (cat.items.length && !confirm(`Delete “${cat.name || 'this category'}” and its ${cat.items.length} scores?`)) return;
      course.categories = course.categories.filter((x) => x !== cat);
      return commit();
    case 'add-item':
      cat.items.push({ id: uid('i'), name: '', score: null, max: 100 });
      commit();
      return focusField(`[data-cat="${cat.id}"] .item:last-child input`);
    case 'del-item':
      cat.items = cat.items.filter((x) => x.id !== el.closest('[data-item]').dataset.item);
      return commit();
    case 'del-course':
      if (!confirm(`Delete ${course.name} and its grades? Its assignments stay, without a course.`)) return;
      state.courses = state.courses.filter((x) => x !== course);
      state.assignments.forEach((a) => {
        if (a.courseId === course.id) a.courseId = null;
      });
      openCourseId = null;
      return commit();

    case 'test-notify':
      requestPermission().then((perm) => {
        if (perm === 'granted') notify('Study Planner', 'Notifications are working.', 'test');
        else toast(perm === 'unsupported' ? 'This browser doesn’t support notifications.' : 'Notifications aren’t allowed for this site.');
        render();
      });
      return;
    case 'new-topic':
      if (!confirm('Make a new topic? You’ll need to subscribe to the new one in the ntfy app.')) return;
      s.ntfyTopic = newTopic();
      state.scheduled = {};
      return commit();
    case 'test-ntfy':
      el.disabled = true;
      publishNtfy(s, { title: 'Study Planner', message: 'Test: phone push is working.' }).then((ok) => {
        el.disabled = false;
        toast(ok ? 'Sent. Check the ntfy app on your phone.' : 'Couldn’t reach the ntfy server. Check the topic and your connection.');
      });
      return;
    case 'bookmarklet':
      // Clicking it here would run it on this page; it's meant to be dragged to the bookmarks bar.
      e.preventDefault();
      return toast('Drag this button to your bookmarks bar, then click it on Brightspace.');
    case 'export': return exportBackup();
    case 'delete-all':
      if (!confirm('Delete all assignments, courses and settings on this device? This can’t be undone.')) return;
      state = defaults();
      state.settings.ntfyTopic = newTopic();
      commit();
      toast('All data deleted.');
      return;
    default:
  }
});

view.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'qa') return updatePreview();
  const card = el.closest('[data-course]');
  const c = card && courseById(card.dataset.course);
  if (!c || !el.dataset.field) return;
  const cat = c.categories.find((x) => x.id === el.closest('[data-cat]')?.dataset.cat);
  const item = cat?.items.find((x) => x.id === el.closest('[data-item]')?.dataset.item);
  const v = el.value;
  switch (el.dataset.field) {
    case 'course-name': if (v.trim()) c.name = v.trim(); break;
    case 'cat-name': cat.name = v; break;
    case 'cat-weight': cat.weight = num(v); break;
    case 'cat-drop': cat.dropLowest = num(v); break;
    case 'item-name': item.name = v; break;
    case 'item-score': item.score = num(v); break;
    case 'item-max': item.max = num(v); break;
    case 'target': c.target = num(v); break;
    case 'final-weight': c.finalWeight = num(v); break;
    default: return;
  }
  refreshCourse(card, c);
  saveSoon();
});

view.addEventListener('change', async (e) => {
  const el = e.target;
  const s = state.settings;
  switch (el.dataset.field) {
    case 'ics-file':
      if (el.files[0]) importFile(await el.files[0].text());
      el.value = '';
      break;
    case 'backup-file':
      if (el.files[0]) await restoreBackup(el.files[0]);
      el.value = '';
      break;
    case 'notify':
      if (el.checked) {
        const perm = await requestPermission();
        s.notify = perm === 'granted';
        if (s.notify) primeReminders(state);
        else toast(perm === 'denied' ? 'Notifications are blocked. Allow them in this site’s browser settings, then try again.' : 'Notifications weren’t turned on.');
      } else {
        s.notify = false;
      }
      commit();
      tick();
      break;
    case 'offset': {
      const minutes = Number(el.value);
      s.offsets = el.checked ? [...new Set([...s.offsets, minutes])].sort((a, b) => b - a) : s.offsets.filter((o) => o !== minutes);
      primeReminders(state);
      commit(false);
      break;
    }
    case 'ntfy':
      s.ntfy = el.checked;
      if (s.ntfy && !s.ntfyTopic) s.ntfyTopic = newTopic();
      commit();
      tick();
      break;
    case 'ntfy-topic':
      s.ntfyTopic = el.value.trim().replace(/[^\w-]/g, '');
      state.scheduled = {};
      commit();
      break;
    case 'ntfy-server':
      s.ntfyServer = el.value.trim() || 'https://ntfy.sh';
      state.scheduled = {};
      commit();
      break;
    case 'course-name':
      render(); // puts the saved name back if the field was left empty
      break;
    default:
  }
});

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  location.hash = b.dataset.tab;
}));

window.addEventListener('hashchange', () => {
  tab = tabFromHash();
  render();
  window.scrollTo(0, 0);
});

// Another open copy of the app changed the data.
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY) return;
  state = load();
  render();
});

// ---------- Sync from Brightspace ----------

// The bookmarklet opens this app at #sync, waits for "ready", then posts the data. Only the tab that opened us
// can hand data over, and mergeImport still asks before adding anything.
let syncPending = false;
if (location.hash === '#sync' && window.opener) {
  syncPending = true;
  history.replaceState(null, '', `${location.pathname}${location.search}#upcoming`);
  window.opener.postMessage({ type: 'study-planner:ready' }, '*');
}
window.addEventListener('message', (e) => {
  if (!syncPending || e.source !== window.opener || e.data?.type !== 'study-planner:import') return;
  if (e.data.data?.kind !== 'study-planner-import') return;
  syncPending = false;
  mergeImport(e.data.data, new URL(e.origin).host);
});

// ---------- Reminder loop ----------

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    let changed = runLocalReminders(state);
    if (await scheduleNtfy(state)) changed = true;
    if (pruneReminderLog(state)) changed = true;
    if (changed) save(state);
  } finally {
    ticking = false;
  }
  if (tab !== 'upcoming' || sheet.open) return;
  if (view.contains(document.activeElement)) refreshRelative();
  else render();
}

if (!state.settings.ntfyTopic) {
  state.settings.ntfyTopic = newTopic();
  save(state);
}
render();
tick();
setInterval(tick, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tick();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
