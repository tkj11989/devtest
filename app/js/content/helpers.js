// Compact constructors for static question banks.
export const M = (cat, d, q, a, w, explain, x = {}) => ({ type: 'mcq', cat, d, q, a, w, explain, ...x });       // multiple choice
export const I = (cat, d, q, answer, explain, x = {}) => ({ type: 'input', cat, d, q, answer, explain, ...x });  // typed answer
export const O = (cat, d, q, items, explain, x = {}) => ({ type: 'order', cat, d, q, items, explain, ...x });    // ordering
export const P = (cat, d, q, pairs, explain, x = {}) => ({ type: 'match', cat, d, q, pairs, explain, ...x });    // matching
export const S = (cat, d, q, buckets, items, explain, x = {}) => ({ type: 'sort', cat, d, q, buckets, items, explain, ...x }); // drag into buckets: items [[text,bucketIdx]]
export const L = (cat, d, q, scenario, slots, explain, x = {}) => ({ type: 'lab', cat, d, q, scenario, slots, explain, ...x }); // experiment: slots [{label,options,answer}]
export const U = (cat, d, q, options, answers, explain, x = {}) => ({ type: 'multi', cat, d, q, options, answers, explain, ...x }); // pick all that apply
export const CORRECT_PCT = [0, 0.6, 0.8, 0.95];
