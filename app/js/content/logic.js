import { M, O } from './helpers.js';

export const cats = [
  { id: 'reason', name: 'Logical Reasoning', emoji: '🧠' },
  { id: 'memory', name: 'Memory', emoji: '🃏' },
  { id: 'pattern', name: 'Patterns', emoji: '🔷' },
  { id: 'seq', name: 'Sequences', emoji: '🔢' },
  { id: 'numpuz', name: 'Number Puzzles', emoji: '🎲' },
  { id: 'visual', name: 'Visual Reasoning', emoji: '👁️' },
  { id: 'solve', name: 'Problem Solving', emoji: '🗝️' },
  { id: 'observe', name: 'Observation', emoji: '🔍' },
];
const SHAPES = ['🔺', '🔵', '🟩', '⭐', '🟣', '🟧', '❤️', '🔶'];
const ANIMALS = ['🐶', '🐱', '🐭', '🐰', '🦊', '🐻', '🐼', '🐸', '🦁', '🐯', '🐵', '🐧'];
const NAMES = ['Asha', 'Ben', 'Chen', 'Dara', 'Eli', 'Fatima', 'Gus', 'Hana'];
const opts = (ans, wrong, r) => { const o = r.shuffle([ans, ...wrong]); return { options: o, answer: o.indexOf(ans) }; };

function lockPuzzle(d, r) {
  // Generate clues that identify a unique 3-digit code (verified by brute force).
  const secret = [r.int(1, 9), r.int(0, 9), r.int(0, 9)];
  const [a, b, c] = secret;
  const preds = [
    [`The digits add up to ${a + b + c}.`, (x, y, z) => x + y + z === a + b + c],
    [`The first digit is ${a % 2 ? 'odd' : 'even'}.`, (x) => x % 2 === a % 2],
    [`The last digit is ${c % 2 ? 'odd' : 'even'}.`, (x, y, z) => z % 2 === c % 2],
    [`The middle digit is ${b > a ? 'greater' : b < a ? 'smaller' : 'equal to'}${b === a ? '' : ' than'} the first digit.`, (x, y) => Math.sign(y - x) === Math.sign(b - a)],
    [`The last digit is ${c > b ? 'greater' : c < b ? 'smaller' : 'equal to'}${c === b ? '' : ' than'} the middle digit.`, (x, y, z) => Math.sign(z - y) === Math.sign(c - b)],
    [`The first digit is ${a > 4 ? 'more than 4' : '4 or less'}.`, (x) => (x > 4) === (a > 4)],
    [`The product of the first two digits is ${a * b}.`, (x, y) => x * y === a * b],
    [`The middle digit is ${b % 3 === 0 ? '' : 'not '}a multiple of 3.`, (x, y) => (y % 3 === 0) === (b % 3 === 0)],
    [`The first and last digits add up to ${a + c}.`, (x, y, z) => x + z === a + c],
    [`The largest digit is ${Math.max(a, b, c)}.`, (x, y, z) => Math.max(x, y, z) === Math.max(a, b, c)],
    [`The code ${new Set(secret).size === 3 ? 'uses three different digits' : 'repeats at least one digit'}.`, (x, y, z) => (new Set([x, y, z]).size === 3) === (new Set(secret).size === 3)],
    [`The last digit is ${c}.`, (x, y, z) => z === c],
  ];
  const countSol = (ps) => { let n = 0; for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) for (let z = 0; z < 10; z++) if (ps.every((p) => p[1](x, y, z))) n++; return n; };
  const chosen = []; const pool = r.shuffle(preds.slice(0, 11)); // exclude the trivial "last digit is" clue until needed
  for (const p of pool) { chosen.push(p); if (countSol(chosen) === 1) break; }
  if (countSol(chosen) !== 1) chosen.push(preds[11], preds[2]);
  if (countSol(chosen) !== 1) { chosen.push([`The middle digit is ${b}.`, (x, y) => y === b]); chosen.push([`The first digit is ${a}.`, (x) => x === a]); }
  return { type: 'lock', q: 'Escape the puzzle room! Use all the clues to set the 3-digit lock.', clues: chosen.map((p) => p[0]), answer: secret.join(''), explain: `Only one code fits every clue: ${secret.join('')}.` };
}

export const gen = {
  seq(d, r) {
    let seq, rule; const s = r.int(1, 8);
    if (d === 1) { const k = r.int(2, 4); seq = [0, 1, 2, 3, 4].map((i) => s + i * k); rule = `+${k} each step`; }
    else if (d === 2) { const k = r.int(3, 7), k2 = r.int(1, 3); seq = [s]; for (let i = 1; i < 6; i++) seq.push(seq[i - 1] + k + (i % 2 ? 0 : k2)); rule = `alternately +${k} and +${k + k2}`; }
    else if (d === 3) { seq = [0, 1, 2, 3, 4].map((i) => s * 2 ** i); rule = '×2 each step'; }
    else if (d === 4) { seq = [1, 2, 3, 4, 5].map((i) => i * i * s + i); rule = `${s}n² + n`; }
    else { seq = [s, s + 1]; for (let i = 2; i < 7; i++) seq.push(seq[i - 1] + seq[i - 2]); rule = 'add the previous two terms'; }
    const hole = seq.length - 1; const ans = seq[hole];
    const wrong = [ans + r.int(1, 3), ans - r.int(1, 3), ans + r.int(4, 8)].filter((v, i, a) => v !== ans && a.indexOf(v) === i);
    while (wrong.length < 3) wrong.push(ans + 10 + wrong.length);
    return { type: 'mcq', q: 'What number comes next?', seq: seq.map((v, i) => (i === hole ? '?' : v)), ...opts(String(ans), wrong.map(String), r), explain: `Rule: ${rule}. Next: ${ans}.` };
  },
  pattern(d, r) {
    const n = Math.min(4, 2 + (d > 2 ? 1 : 0) + (d > 4 ? 1 : 0)); const base = r.shuffle(SHAPES).slice(0, n);
    const cycle = base; const len = cycle.length * 2 + 1; const seq = Array.from({ length: len }, (_, i) => cycle[i % cycle.length]);
    const ans = seq[len - 1]; seq[len - 1] = '❓';
    const wrong = SHAPES.filter((s) => s !== ans).slice(0, 3);
    return { type: 'mcq', q: 'Which shape completes the pattern?', seq, ...opts(ans, wrong, r), explain: `The pattern repeats every ${n} shapes, so ${ans} comes next.` };
  },
  memory(d, r) {
    const count = 3 + d; const pool = r.shuffle(ANIMALS); const show = pool.slice(0, count);
    return { type: 'memory', q: `Memorise the order of the ${count} friends, then tap them in the same order!`, show, choices: r.shuffle(pool.slice(0, Math.min(ANIMALS.length, count + 3))), showMs: 1200 * count + 800, explain: `The order was ${show.join(' ')}.` };
  },
  reason(d, r) {
    const n = Math.min(NAMES.length, 3 + (d > 3 ? 1 : 0)); const order = r.shuffle(NAMES).slice(0, n); // tallest → shortest
    const clues = []; for (let i = 0; i < n - 1; i++) clues.push(`${order[i]} is taller than ${order[i + 1]}.`);
    const shuffledClues = r.shuffle(clues); const askTall = r.chance(0.5); const ans = askTall ? order[0] : order[n - 1];
    const wrong = order.filter((x) => x !== ans).slice(0, 3);
    return { type: 'mcq', q: `${shuffledClues.join(' ')} Who is the ${askTall ? 'tallest' : 'shortest'}?`, ...opts(ans, wrong, r), explain: `Chain the clues: ${order.join(' > ')}. So the ${askTall ? 'tallest' : 'shortest'} is ${ans}.` };
  },
  numpuz(d, r) {
    const k = r.int(0, 2);
    if (k === 0) { const t = r.int(8, 12 + d * 3), cells = [r.int(1, 5)]; cells.push(t - cells[0]); return { type: 'input', q: `Magic pair: two numbers add to ${t}. One is ${cells[0]}. What is the other?`, answer: cells[1], explain: `${t} − ${cells[0]} = ${cells[1]}.` }; }
    if (k === 1) { const a = r.int(2, 5 + d), b = r.int(2, 5 + d); return { type: 'input', q: `If 🍎 + 🍎 = ${2 * a} and 🍎 × 🍌 = ${a * b}, what does 🍌 equal?`, answer: b, explain: `🍎 = ${a}, so 🍌 = ${a * b} ÷ ${a} = ${b}.` }; }
    const a = r.int(2, 4 + d), b = r.int(2, 5 + d), c = r.int(1, 5 + d); return { type: 'input', q: `🔷 = ${a}, 🔶 = ${b}. What is 🔷 × 🔶 + ${c}?`, answer: a * b + c, explain: `${a} × ${b} + ${c} = ${a * b + c}.` };
  },
  visual(d, r) { // matrix 3x3 with missing cell
    const set = r.shuffle(SHAPES).slice(0, 3); const shift = r.int(1, 2);
    const grid = []; for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) grid.push(set[(row * shift + col) % 3]);
    const ans = grid[8]; grid[8] = '❓';
    const wrong = SHAPES.filter((s) => s !== ans).slice(0, 3);
    return { type: 'mcq', q: 'Every row and column uses each shape once. Which shape belongs in the missing cell?', matrix: grid, ...opts(ans, wrong, r), explain: `Each row and column contains all three shapes, so the missing one is ${ans}.` };
  },
  solve(d, r) { return lockPuzzle(d, r); },
  observe(d, r) {
    const base = r.pick(ANIMALS); const odd = r.pick(ANIMALS.filter((a) => a !== base)); const n = 6 + d * 2; const pos = r.int(0, n - 1);
    const items = Array.from({ length: n }, (_, i) => (i === pos ? odd : base));
    return { type: 'mcq', q: 'Spot the odd one out. Which creature is different?', seq: items, ...opts(odd, [base, ...ANIMALS.filter((a) => a !== base && a !== odd).slice(0, 2)], r), explain: `All were ${base} except the ${odd}.` };
  },
  lockAny: lockPuzzle,
};
export const alt = { solve: ['solve'], reason: ['reason'], memory: ['memory'], seq: ['seq'] };
export const bank = [
  M('reason', 1, 'All birds have feathers. A sparrow is a bird. What must be true?', 'A sparrow has feathers', ['A sparrow cannot fly', 'All feathered animals are sparrows', 'Sparrows are not birds'], 'If all birds have feathers and a sparrow is a bird, it has feathers.'),
  M('reason', 2, 'No reptiles are warm-blooded. A snake is a reptile. What follows?', 'A snake is not warm-blooded', ['A snake is warm-blooded', 'Some reptiles are warm-blooded', 'Nothing can be said'], 'The “no reptiles” rule applies to snakes.'),
  M('reason', 3, 'If it rains, the ground gets wet. The ground is wet. Can we be sure it rained?', 'No — something else could have wet it', ['Yes, always', 'Yes, but only at night', 'No, because rain never wets ground'], 'Wet ground does not prove rain (a hose could do it). That’s “affirming the consequent”.'),
  M('reason', 4, 'Three boxes are labelled Apples, Oranges, Mixed — all labels are wrong. You pick one fruit from the box labelled “Mixed” and it is an apple. What is in the “Mixed” box?', 'Apples', ['Oranges', 'Mixed fruit', 'Cannot tell'], 'The “Mixed” label is wrong, so it holds only one fruit type: apples.'),
  M('reason', 5, 'Knights always tell the truth; knaves always lie. A says “We are both knaves.” What is A?', 'A knave, and B is a knight', ['A knight, and B a knave', 'Both are knaves', 'Both are knights'], 'A knight can’t say it (false). If A is a knave the statement is false, so B must be a knight.'),
  M('solve', 2, 'A farmer has 17 sheep. All but 9 run away. How many are left?', '9', ['8', '17', '0'], '“All but 9” means 9 stay.'),
  M('solve', 3, 'You have a 3-litre and a 5-litre jug. How can you measure exactly 4 litres?', 'Fill the 5L, pour into the 3L, empty the 3L, pour the remaining 2L into it, refill the 5L and top up the 3L', ['Fill the 3L twice', 'Fill the 5L and pour out half', 'It is impossible'], 'This classic puzzle gives 5 → 3 leaves 2; move 2 to the 3L jug; refill the 5L and fill the 3L (needs 1) leaving 4.'),
  M('reason', 1, 'How many days are in February in a leap year?', '29', ['28', '30', '31'], 'Leap years add a 29th day to February.'),
  O('seq', 2, 'Put these steps of the lock puzzle in a sensible order.', ['Read the clues', 'Eliminate impossible digits', 'Set the dials', 'Open the door'], 'Read → eliminate → set → open.'),
];
export const boss = { title: 'The Riddle Sphinx', desc: 'Crack the locks and deductions to unlock the final chamber!', count: 4, minD: 4, cats: ['solve', 'reason'] };
export const titles = ['Entrance Hall', 'Memory Cellar', 'Pattern Parlour', 'Sequence Stairs', 'Number Nook', 'Mirror Gallery', 'Clock Tower', 'Detective Den', 'Secret Library', 'The Final Chamber'];
