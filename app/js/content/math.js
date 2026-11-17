import { distractNums } from '../util.js';

export const cats = [
  { id: 'arith', name: 'Add & Subtract', emoji: '➕' },
  { id: 'muldiv', name: 'Multiply & Divide', emoji: '✖️' },
  { id: 'frac', name: 'Fractions & Percent', emoji: '🍕' },
  { id: 'pattern', name: 'Number Patterns', emoji: '🔢' },
  { id: 'mental', name: 'Mental Maths', emoji: '⚡' },
  { id: 'reason', name: 'Reasoning', emoji: '🧠' },
  { id: 'algebra', name: 'Basic Algebra', emoji: '🔤' },
  { id: 'puzzle', name: 'Math Puzzles', emoji: '🧩' },
];

const num = (q, ans, explain, extra = {}) => ({ type: 'input', q, answer: ans, explain, ...extra });
function mcqNum(q, ans, rng, explain, extra = {}) {
  const opts = rng.shuffle([ans, ...distractNums(ans, rng)]);
  return { type: 'mcq', q, options: opts.map(String), answer: opts.indexOf(ans), explain, ...extra };
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const T = ['castle gate', 'bridge', 'tower', 'dragon cave', 'treasure vault'];

export const gen = {
  arith(d, r) {
    const f = r.int(0, 2);
    if (d === 1) { const a = r.int(2, 12), b = r.int(2, 9); return f ? mcqNum(`The wizard has ${a + b} gems and gives away ${b}. How many are left?`, a, r, `${a + b} − ${b} = ${a}.`) : num(`${a} + ${b} = ?`, a + b, `${a} + ${b} = ${a + b}.`); }
    if (d === 2) { const a = r.int(20, 99), b = r.int(11, 60); return f ? num(`${a + b} − ${b} = ?`, a, `${a + b} − ${b} = ${a}.`) : mcqNum(`${a} + ${b} = ?`, a + b, r, `Add tens then ones: ${a} + ${b} = ${a + b}.`); }
    if (d === 3) { const a = r.int(120, 899), b = r.int(110, 99 + 400); return f ? num(`${a + b} − ${a} = ?`, b, `Subtracting ${a} undoes adding it, leaving ${b}.`) : num(`${a} + ${b} = ?`, a + b, `${a} + ${b} = ${a + b}.`); }
    if (d === 4) { const a = r.int(1200, 8999), b = r.int(1100, 4999); return f ? num(`${a + b} − ${b} = ?`, a, `${a + b} − ${b} = ${a}.`) : mcqNum(`${a} + ${b} = ?`, a + b, r, `Add column by column: ${a + b}.`); }
    const a = r.int(500, 9000), b = r.int(100, 4000), c = r.int(50, 900);
    return num(`${a} + ${b} − ${c} = ?`, a + b - c, `Do it left to right: ${a} + ${b} = ${a + b}, then − ${c} = ${a + b - c}.`);
  },
  muldiv(d, r) {
    if (d === 1) { const a = r.pick([2, 5, 10]), b = r.int(1, 10); return num(`${a} × ${b} = ?`, a * b, `${a} groups of ${b} make ${a * b}.`); }
    if (d === 2) { const a = r.int(2, 10), b = r.int(2, 10); return r.chance(0.5) ? mcqNum(`${a} × ${b} = ?`, a * b, r, `${a} × ${b} = ${a * b}.`) : num(`${a * b} ÷ ${a} = ?`, b, `${a} × ${b} = ${a * b}, so ${a * b} ÷ ${a} = ${b}.`); }
    if (d === 3) { const a = r.int(12, 49), b = r.int(3, 9); return r.chance(0.5) ? num(`${a} × ${b} = ?`, a * b, `Split ${a} into tens and ones: ${a * b}.`) : num(`${a * b} ÷ ${b} = ?`, a, `${b} × ${a} = ${a * b}.`); }
    if (d === 4) { const a = r.int(12, 35), b = r.int(11, 25); return num(`${a} × ${b} = ?`, a * b, `${a} × ${b} = ${a * b}.`); }
    const b = r.int(12, 25), a = r.int(11, 60), rem = r.int(1, b - 1); return num(`${a * b + rem} ÷ ${b}: what is the quotient (whole-number part)?`, a, `${b} × ${a} = ${a * b}, remainder ${rem}.`);
  },
  frac(d, r) {
    if (d === 1) { const n = r.int(2, 20) * 2, h = r.chance(0.5); return num(`What is ${h ? 'half' : 'a quarter'} of ${h ? n : n * 2}?`, h ? n / 2 : n / 2, h ? `Half of ${n} is ${n / 2}.` : `A quarter of ${n * 2} is ${n / 2}.`); }
    if (d === 2) { const p = r.pick([10, 50, 100, 25]), n = r.int(1, 20) * 4; return num(`What is ${p}% of ${n * 10}?`, (p * n * 10) / 100, `${p}% means ${p} out of 100: ${(p * n * 10) / 100}.`); }
    if (d === 3) { const den = r.pick([5, 6, 8, 10, 12]), a = r.int(1, den - 2), b = r.int(1, den - 1 - a); return mcqNum(`${a}/${den} + ${b}/${den} = ?/${den}. Find the numerator.`, a + b, r, `Same denominator: add numerators ${a} + ${b} = ${a + b}.`); }
    if (d === 4) { const p = r.pick([15, 35, 40, 60, 45, 25]), n = r.int(2, 20) * 20; return num(`What is ${p}% of ${n}?`, (p * n) / 100, `${p}% of ${n} = ${p} × ${n} ÷ 100 = ${(p * n) / 100}.`); }
    const price = r.int(2, 10) * 100, p = r.pick([10, 20, 25, 40]); const up = r.chance(0.5);
    return num(`A value of ${price} ${up ? 'increases' : 'decreases'} by ${p}%. What is the new value?`, up ? price + (price * p) / 100 : price - (price * p) / 100, `${p}% of ${price} is ${(price * p) / 100}; ${up ? 'add' : 'subtract'} it.`);
  },
  pattern(d, r) {
    let seq, ans, rule;
    const start = r.int(1, 15);
    if (d <= 2) { const st = d === 1 ? r.int(2, 5) : r.int(3, 9); seq = [0, 1, 2, 3, 4, 5].map((i) => start + i * st); rule = `add ${st} each time`; }
    else if (d === 3) { const k = r.int(2, 3); seq = [0, 1, 2, 3, 4].map((i) => start * k ** i); rule = `multiply by ${k} each time`; }
    else if (d === 4) { seq = [1, 2, 3, 4, 5, 6].map((i) => (i + start % 5) ** 2); rule = 'perfect squares'; }
    else { let a = r.int(1, 4), b = r.int(2, 6); seq = [a, b]; for (let i = 2; i < 7; i++) seq.push(seq[i - 1] + seq[i - 2]); rule = 'each number is the sum of the two before it'; }
    const hole = r.int(2, seq.length - 1); ans = seq[hole];
    const shown = seq.map((v, i) => (i === hole ? '?' : v));
    return { type: 'input', q: 'Repair the number bridge: which number is missing?', seq: shown, answer: ans, explain: `Rule: ${rule}. The missing number is ${ans}.` };
  },
  mental(d, r) {
    if (d <= 2) { const a = r.int(2, 9) * 10 + r.int(0, 9), b = r.pick([9, 10, 11, 19]); return mcqNum(`Quick! ${a} + ${b}`, a + b, r, `Round, add, adjust: ${a + b}.`, { timed: 12 }); }
    if (d === 3) { const a = r.pick([4, 8, 12, 16, 24]), b = r.pick([25, 5, 50]); return num(`Quick! ${a} × ${b}`, a * b, `${a} × ${b} = ${a * b}.`, { timed: 15 }); }
    if (d === 4) { const a = r.int(2, 9), b = r.int(2, 9), c = r.int(2, 9); return num(`Quick! (${a} + ${b}) × ${c}`, (a + b) * c, `Brackets first: ${a + b} × ${c} = ${(a + b) * c}.`, { timed: 15 }); }
    const a = r.int(12, 40), b = r.int(3, 9); return num(`Quick! ${a} × ${b} − ${a}`, a * b - a, `${a} × ${b} = ${a * b}; minus ${a} gives ${a * b - a}. (Same as ${a} × ${b - 1}.)`, { timed: 20 });
  },
  reason(d, r) {
    const n = [3, 6, 12, 25, 40][d - 1] ?? 3; const a = r.int(2, 4 + d), b = r.int(2, 5 + d);
    const k = r.int(0, 3);
    if (k === 0) return num(`A ${r.pick(T)} guard collects ${a} coins each hour. How many coins after ${b + d} hours?`, a * (b + d), `${a} × ${b + d} = ${a * (b + d)}.`);
    if (k === 1) { const tot = (a + 3) * (b + 1) ; return num(`${tot} apples are shared equally by ${b + 1} elves. How many does each get?`, a + 3, `${tot} ÷ ${b + 1} = ${a + 3}.`); }
    if (k === 2) { const x = r.int(20, 60) + d * 10; return mcqNum(`Mira has ${x} stars and earns ${n} more, then spends ${a}. How many stars now?`, x + n - a, r, `${x} + ${n} − ${a} = ${x + n - a}.`); }
    const w = r.int(3, 9) + d; return mcqNum(`A rectangle is ${w} long and ${a + 1} wide. What is its perimeter?`, 2 * (w + a + 1), r, `Perimeter = 2 × (${w} + ${a + 1}) = ${2 * (w + a + 1)}.`);
  },
  algebra(d, r) {
    const x = r.int(2, 12 + d * 2), a = r.int(2, 9), b = r.int(1, 15 + d * 3);
    if (d === 1) return num(`x + ${a} = ${x + a}. What is x?`, x, `Subtract ${a} from both sides: x = ${x}.`);
    if (d === 2) return mcqNum(`x − ${a} = ${x}. What is x?`, x + a, r, `Add ${a} to both sides: x = ${x + a}.`);
    if (d === 3) return num(`${a}x = ${a * x}. What is x?`, x, `Divide both sides by ${a}: x = ${x}.`);
    if (d === 4) return num(`${a}x + ${b} = ${a * x + b}. What is x?`, x, `Subtract ${b}: ${a}x = ${a * x}; divide by ${a}: x = ${x}.`);
    const c = r.int(2, 4); return num(`${c}(x + ${a}) = ${c * (x + a)}. What is x?`, x, `Divide by ${c}: x + ${a} = ${x + a}; so x = ${x}.`);
  },
  puzzle(d, r) {
    const k = r.int(0, 2), x = r.int(2, 8 + d * 2), m = r.int(2, 4), a = r.int(1, 9);
    if (k === 0) return num(`I think of a number, add ${a}, then multiply by ${m}. The result is ${(x + a) * m}. What was my number?`, x, `Work backwards: ${(x + a) * m} ÷ ${m} = ${x + a}, minus ${a} = ${x}.`);
    if (k === 1) { const total = x + (x + a) ; return num(`Two numbers add up to ${total}. One is ${a} bigger than the other. What is the smaller number?`, x, `Smaller = (${total} − ${a}) ÷ 2 = ${x}.`); }
    const g = r.pick([2, 3, 4, 5, 6]); const n1 = g * r.int(2, 6), n2 = g * r.int(7, 12);
    return num(`What is the largest number that divides both ${n1} and ${n2}? (Greatest common factor)`, gcd(n1, n2), `The greatest common factor of ${n1} and ${n2} is ${gcd(n1, n2)}.`);
  },
  // Extra formats for variety (chosen by engine when cat has `alt`)
  matchExpr(d, r) {
    const base = r.int(2, 6 + d);
    const exprs = [`${base} × 3`, `${base + 4} + ${base}`, `${base * 5} − ${base}`, `${base * 7} − ${base * 2}`].slice(0, 4);
    const vals = [base * 3, base * 2 + 4, base * 4, base * 5];
    const uniq = [...new Set(vals)];
    const pairs = exprs.map((e, i) => [e, String(vals[i])]).filter((p, i, a) => a.findIndex((z) => z[1] === p[1]) === i);
    return { type: 'match', q: 'Open the gates: match each sum to its answer.', pairs, explain: pairs.map((p) => `${p[0]} = ${p[1]}`).join('; ') + '.' };
  },
  orderNums(d, r) {
    const lo = 10 ** Math.min(d, 3);
    const set = new Set(); while (set.size < 4) set.add(r.int(lo, lo * 9));
    const items = [...set].sort((a, b) => a - b).map(String);
    return { type: 'order', q: 'Build the bridge: tap the numbers from smallest to largest.', items, explain: `Ascending order: ${items.join(' < ')}.` };
  },
};
// Which generator functions serve each category (allows mixed question formats).
export const alt = { arith: ['arith', 'orderNums'], muldiv: ['muldiv', 'matchExpr'], mental: ['mental', 'matchExpr'], puzzle: ['puzzle'], pattern: ['pattern', 'orderNums'] };
export const boss = { title: 'The Number Dragon', desc: 'Solve 8 hard puzzles in a row to unlock the castle!', count: 8, minD: 4, cats: ['algebra', 'puzzle', 'frac', 'reason', 'pattern'] };
export const titles = ['Gate of Ones', 'Bridge of Sums', 'Tower of Tables', 'Fraction Fountain', 'Pattern Path', 'Mental Maze', 'Reasoning Ridge', 'Algebra Archway', 'Puzzle Palace', 'Royal Treasury'];
