// Structural validation for runtime/admin questions. Used by tests, the admin editor and the engine safety net.
export function validateQuestion(q) {
  const e = []; const need = (c, m) => { if (!c) e.push(m); };
  need(q && typeof q === 'object', 'not an object'); if (!q) return { ok: false, errors: e };
  need(typeof q.q === 'string' && q.q.trim().length > 3, 'missing question text');
  need(q.d === undefined || (q.d >= 1 && q.d <= 5), 'difficulty must be 1-5');
  switch (q.type) {
    case 'mcq': need(Array.isArray(q.options) && q.options.length >= 2, 'needs 2+ options'); need(Number.isInteger(q.answer) && q.options && q.answer >= 0 && q.answer < q.options.length, 'answer index out of range'); need(new Set(q.options).size === q.options?.length, 'duplicate options'); break;
    case 'input': need(q.answer !== undefined && q.answer !== '', 'missing answer'); break;
    case 'order': need(Array.isArray(q.items) && q.items.length >= 2, 'needs items'); need(Array.isArray(q.shuffled) && q.shuffled.length === q.items?.length, 'needs shuffled'); break;
    case 'match': need(Array.isArray(q.pairs) && q.pairs.length >= 2, 'needs 2+ pairs'); need(new Set((q.pairs || []).map((p) => p[1])).size === q.pairs?.length, 'duplicate match targets'); need(new Set((q.pairs || []).map((p) => p[0])).size === q.pairs?.length, 'duplicate match sources'); break;
    case 'sort': need(q.buckets?.length >= 2 && q.items?.length >= 2, 'needs buckets+items'); need((q.items || []).every((i) => i[1] >= 0 && i[1] < q.buckets.length), 'bad bucket index'); break;
    case 'lab': need(q.slots?.length >= 1 && q.slots.every((s) => s.options?.length >= 2 && s.answer >= 0 && s.answer < s.options.length), 'bad lab slots'); break;
    case 'multi': need(q.options?.length >= 2 && q.answers?.length >= 1 && q.answers.every((i) => i >= 0 && i < q.options.length), 'bad multi'); if (q.budget) need(q.answers.reduce((s, i) => s + (q.options[i].price || 0), 0) <= q.budget, 'correct set exceeds budget'); break;
    case 'memory': need(q.show?.length >= 2 && q.choices?.length >= q.show.length && q.show.every((x) => q.choices.includes(x)), 'bad memory'); break;
    case 'hunt': need(q.grid?.length === q.n * q.n && q.cells?.length >= 2 && q.cells.map((i) => q.grid[i]).join('') === q.word, 'hunt cells must spell word'); break;
    case 'map': need(q.target && Math.abs(q.target.lat) <= 90 && Math.abs(q.target.lon) <= 180, 'bad map target'); break;
    case 'lock': need(/^\d{3}$/.test(String(q.answer)) && q.clues?.length >= 1, 'bad lock'); break;
    default: e.push('unknown type ' + q.type);
  }
  return { ok: e.length === 0, errors: e };
}
