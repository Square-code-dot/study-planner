// "Sync from Brightspace": a bookmarklet the student clicks on their own Brightspace page while signed in.
// It reads courses, due dates and released grades with the same read-only API calls Brightspace's own pages
// make, then hands the result to this app in a new tab. Nothing changes in Brightspace and nothing goes elsewhere.

export function bookmarkletHref(appUrl) {
  // Indentation and whole-line comments are dropped to keep the bookmark short; line breaks stay, so code is unchanged.
  const source = String(runSync).replace(/\n\s+/g, '\n').replace(/^\/\/.*\n/gm, '');
  return `javascript:${encodeURIComponent(`(${source})(${JSON.stringify(appUrl)})`)}`;
}

// Runs inside the Brightspace page, so it can't use anything outside its own body.
// Without an appUrl it just returns the import data, which is how it's tested.
async function runSync(appUrl) {
  const DAY = 864e5;
  const now = Date.now();
  const until = now + 200 * DAY;
  if (!/\/d2l\//.test(location.pathname)) {
    alert('Open your Brightspace home page (signed in), then click Sync from Brightspace again.');
    return null;
  }

  // Open the app first: browsers only allow a new tab straight after a click.
  const appOrigin = appUrl && new URL(appUrl).origin;
  const win = appUrl ? window.open(`${appUrl}#sync`, '_blank') : null;
  let appReady = false;
  const onMessage = (e) => {
    if (e.source === win && e.data?.type === 'study-planner:ready') appReady = true;
  };
  addEventListener('message', onMessage);

  const badge = appUrl ? document.createElement('div') : null;
  const say = (text) => {
    if (badge) badge.textContent = text;
  };
  if (badge) {
    badge.setAttribute('role', 'status');
    badge.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;padding:12px 16px;'
      + 'border-radius:12px;background:#3b5bdb;color:#fff;font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    document.body.append(badge);
    say('Study Planner: reading Brightspace…');
  }

  const get = async (path) => {
    const r = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Brightspace answered ${r.status}`);
    return r.json();
  };
  const tryGet = (path, fallback = null) => get(path).catch(() => fallback);
  const upcoming = (iso) => Boolean(iso) && Date.parse(iso) > now && Date.parse(iso) < until;

  // "26FA GENERAL BIOLOGYLAB(BIO101-L02-LAB-TRA)1234" -> "General Biology Lab"
  const SMALL = /^(a|an|and|as|at|by|for|in|of|on|or|the|to|vs)$/;
  const niceName = (raw) => {
    const isLab = (/\(([^)]*)\)/.exec(raw)?.[1] || '').toUpperCase().split('-').includes('LAB');
    let name = raw.replace(/\s*\([^)]*\)\s*\d*\s*$/, '').replace(/^\d{2}[A-Z]{2}\s+/, '').trim();
    if (name && name === name.toUpperCase()) {
      name = name.replace(/(\S)LAB$/, '$1 LAB').toLowerCase().replace(/[\w&']+/g, (w, i) => {
        if (/^(i|ii|iii|iv|v|vi)$/.test(w) || /\d/.test(w)) return w.toUpperCase();
        return i > 0 && SMALL.test(w) ? w : w[0].toUpperCase() + w.slice(1);
      });
    }
    if (isLab && !/\blab\b/i.test(name)) name += ' Lab';
    return name || raw.trim();
  };

  // Released scores, grouped the way the course's gradebook groups them.
  const gradeCategories = (setup, cats, objs, vals) => {
    const scores = new Map(vals.filter((v) => v.PointsNumerator != null && v.PointsDenominator)
      .map((v) => [String(v.GradeObjectIdentifier), v.PointsNumerator]));
    const items = objs.filter((o) => ['Numeric', 'SelectBox'].includes(o.GradeType) && o.MaxPoints > 0
      && !o.ExcludeFromFinalGradeCalculation && !o.IsBonus);
    if (!items.some((o) => scores.has(String(o.Id)))) return [];
    const byPoints = setup.GradingSystem === 'Points';
    const item = (o) => ({ name: o.Name.trim(), score: scores.get(String(o.Id)) ?? null, max: o.MaxPoints });
    const sumMax = (list) => list.reduce((sum, o) => sum + o.MaxPoints, 0);
    const out = [];
    for (const c of cats) {
      const inCat = items.filter((o) => o.CategoryId === c.Id);
      if (c.ExcludeFromFinalGrade || !inCat.length) continue;
      out.push({
        name: c.Name.trim(), weight: byPoints ? c.MaxPoints || sumMax(inCat) : c.Weight,
        dropLowest: c.NumberOfLowestToDrop || 0, items: inCat.map(item),
      });
    }
    const loose = items.filter((o) => !cats.some((c) => c.Id === o.CategoryId));
    if (loose.length) {
      out.push({
        name: out.length ? 'Other graded work' : 'Graded in Brightspace',
        weight: !out.length ? 100 : byPoints ? sumMax(loose) : loose.reduce((sum, o) => sum + (o.Weight || 0), 0),
        items: loose.map(item),
      });
    }
    return out;
  };

  try {
    const versions = await get('/d2l/api/versions/');
    const version = (code) => versions.find((v) => v.ProductCode === code)?.LatestVersion;
    const lp = `/d2l/api/lp/${version('lp')}`;
    const le = `/d2l/api/le/${version('le')}`;

    const enrollments = [];
    let bookmark = '';
    for (let i = 0; i < 20; i++) {
      const page = await get(`${lp}/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''}`);
      enrollments.push(...page.Items);
      if (!page.PagingInfo?.HasMoreItems) break;
      bookmark = page.PagingInfo.Bookmark;
    }
    // Courses running now. Sandboxes and trainings without dates are left out.
    const current = enrollments.filter((e) => e.Access.CanAccess && e.Access.StartDate && e.Access.EndDate
      && Date.parse(e.Access.StartDate) <= now + 14 * DAY && Date.parse(e.Access.EndDate) >= now);

    const courses = [];
    const assignments = [];
    for (const [n, e] of current.entries()) {
      say(`Study Planner: reading course ${n + 1} of ${current.length}…`);
      const ou = e.OrgUnit.Id;
      const ref = `d2l:${ou}`;
      const [folders, quizzes, setup, cats, objs, vals, final] = await Promise.all([
        tryGet(`${le}/${ou}/dropbox/folders/`, []),
        tryGet(`${le}/${ou}/quizzes/`, {}),
        tryGet(`${le}/${ou}/grades/setup/`, {}),
        tryGet(`${le}/${ou}/grades/categories/`, []),
        tryGet(`${le}/${ou}/grades/`, []),
        tryGet(`${le}/${ou}/grades/values/myGradeValues/`, []),
        tryGet(`${le}/${ou}/grades/final/values/myGradeValue`),
      ]);
      for (const f of folders) {
        if (f.IsHidden || !upcoming(f.DueDate)) continue;
        const mine = await tryGet(`${le}/${ou}/dropbox/folders/${f.Id}/submissions/mysubmissions/`, []);
        assignments.push({
          uid: `d2l-dropbox-${f.Id}`, title: f.Name.trim(), courseId: ref, due: f.DueDate,
          done: mine.some((m) => m.Submissions?.length), notes: 'From Brightspace (Assignments).',
        });
      }
      for (const q of quizzes.Objects || []) {
        const due = q.DueDate || q.EndDate;
        if (!q.IsActive || !upcoming(due)) continue;
        assignments.push({ uid: `d2l-quiz-${q.QuizId}`, title: q.Name.trim(), courseId: ref, due, notes: 'From Brightspace (Quizzes).' });
      }
      const course = { id: ref, ref, name: niceName(e.OrgUnit.Name), start: e.Access.StartDate };
      const categories = gradeCategories(setup, cats, objs, vals);
      if (categories.length) {
        course.categories = categories;
        const total = categories.reduce((sum, c) => sum + (c.weight || 0), 0);
        const finalCat = categories.find((c) => /final/i.test(c.name));
        if (finalCat && total) course.finalWeight = Math.round((finalCat.weight / total) * 1000) / 10;
      }
      if (final?.PointsDenominator) {
        course.portalGrade = { percent: (final.PointsNumerator / final.PointsDenominator) * 100, label: final.DisplayedGrade || '' };
      }
      courses.push(course);
    }

    // Other dated items on the course calendars: content topics, discussions, and exams the instructor added.
    const refs = new Map(current.map((e) => [e.OrgUnit.Id, `d2l:${e.OrgUnit.Id}`]));
    let next = refs.size
      ? `${le}/calendar/events/myEvents/?orgUnitIdsCSV=${[...refs.keys()].join(',')}&startDateTime=${new Date(now).toISOString()}&endDateTime=${new Date(until).toISOString()}`
      : null;
    for (let i = 0; next && i < 20; i++) {
      const page = await tryGet(next, {});
      for (const ev of page.Objects || []) {
        const linked = ev.AssociatedEntity?.AssociatedEntityType || '';
        const title = (ev.Title || '').trim();
        if (/dropbox|quiz/i.test(linked)) continue; // already read above, with submission status
        if (!linked && !/exam|quiz|test|midterm|final|due|project|paper|report|presentation|essay/i.test(title)) continue;
        if (/\b(opens|is available|availability starts|starts|begins)$/i.test(title)) continue;
        const due = ev.IsAllDayEvent && (ev.EndDay || ev.StartDay)
          ? new Date(`${(ev.EndDay || ev.StartDay).slice(0, 10)}T23:59:00`).toISOString()
          : ev.EndDateTime || ev.StartDateTime;
        if (!upcoming(due)) continue;
        assignments.push({
          uid: `d2l-event-${ev.CalendarEventId}`, courseId: refs.get(ev.OrgUnitId) || null, due,
          title: title.replace(/\s*(?:[-–:]\s*)?(?:is due|due|availability ends)$/i, '') || title, notes: 'From the Brightspace calendar.',
        });
      }
      next = page.Next || null;
    }

    // Keep this term's courses, plus any older course that still has grades or deadlines.
    const latest = Math.max(...courses.map((c) => Date.parse(c.start)));
    const used = new Set(assignments.map((a) => a.courseId));
    const keep = courses
      .filter((c) => c.categories || used.has(c.ref) || Date.parse(c.start) >= latest - 21 * DAY)
      .map(({ start, ...c }) => c);

    const data = {
      kind: 'study-planner-import', version: 1, source: `Brightspace (${location.hostname})`,
      syncedAt: new Date().toISOString(), courses: keep, assignments,
    };
    if (!appUrl) return data;

    say('Study Planner: handing over to the app…');
    for (let i = 0; i < 80 && !appReady && win && !win.closed; i++) await new Promise((r) => setTimeout(r, 250));
    if (appReady) {
      win.postMessage({ type: 'study-planner:import', data }, appOrigin);
      say('Done. Switch to the Study Planner tab to finish.');
    } else {
      // New tab blocked, or the app didn't answer: save a file the app can import instead.
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      link.download = `brightspace-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      say('Study Planner didn’t open, so your data was saved as a file. Import it in Study Planner → Settings → Import.');
    }
    return data;
  } catch (err) {
    say(`Study Planner couldn’t read Brightspace (${err.message}). Check that you’re signed in, then try again.`);
    return null;
  } finally {
    removeEventListener('message', onMessage);
    if (badge) setTimeout(() => badge.remove(), 10000);
  }
}
