// Weighted grade math. Scores are points earned / points possible inside each category.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// The `dropLowest` worst scores (by percentage) don't count, like Brightspace's "drop lowest". One always stays.
export function droppedItems(cat) {
  const scored = cat.items.filter((it) => isNum(it.score) && isNum(it.max) && it.max > 0);
  const drop = Math.max(0, Math.min(Math.floor(cat.dropLowest || 0), scored.length - 1));
  return new Set(scored.sort((a, b) => a.score / a.max - b.score / b.max).slice(0, drop));
}

export function categoryPercent(cat) {
  const dropped = droppedItems(cat);
  let earned = 0;
  let possible = 0;
  for (const it of cat.items) {
    if (isNum(it.score) && isNum(it.max) && it.max > 0 && !dropped.has(it)) {
      earned += it.score;
      possible += it.max;
    }
  }
  return possible ? (earned / possible) * 100 : null;
}

// Averages only the categories that have scores, so an empty "Final exam" category doesn't count as a zero.
export function courseGrade(course) {
  let total = 0;
  let weights = 0;
  for (const cat of course.categories) {
    const pct = categoryPercent(cat);
    const w = isNum(cat.weight) ? cat.weight : 0;
    if (pct === null || w <= 0) continue;
    total += pct * w;
    weights += w;
  }
  return weights ? { percent: total / weights, weights } : null;
}

const LETTERS = [[97, 'A+'], [93, 'A'], [90, 'A−'], [87, 'B+'], [83, 'B'], [80, 'B−'], [77, 'C+'], [73, 'C'], [70, 'C−'], [67, 'D+'], [63, 'D'], [60, 'D−']];

export function letterGrade(pct) {
  return (LETTERS.find(([min]) => pct >= min) || [0, 'F'])[1];
}

// Score needed on a final worth `finalWeight`% to finish at `target`%, if everything else stays where it is.
export function neededOnFinal(current, target, finalWeight) {
  const w = finalWeight / 100;
  return (target - current * (1 - w)) / w;
}
