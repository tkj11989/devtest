import { M, S, U } from './helpers.js';
import { distractNums } from '../util.js';
export const cats = [
  { id: 'calc', name: 'Money Calculations', emoji: '🧮' }, { id: 'budget', name: 'Budgeting', emoji: '📊' },
  { id: 'save', name: 'Saving', emoji: '🐷' }, { id: 'spend', name: 'Spending Decisions', emoji: '🛒' },
  { id: 'shop', name: 'Shopping', emoji: '🛍️' }, { id: 'disc', name: 'Discounts', emoji: '🏷️' },
  { id: 'plan', name: 'Financial Planning', emoji: '🗓️' }, { id: 'lit', name: 'Financial Literacy', emoji: '🏦' },
];
const cur = () => globalThis.__KV_CUR || '$';
const f = (n) => `${cur()}${Number.isInteger(n) ? n : n.toFixed(2)}`;
const mcqNum = (q, ans, r, explain, x = {}) => { const o = r.shuffle([ans, ...distractNums(ans, r)]); return { type: 'mcq', q, options: o.map(f), answer: o.indexOf(ans), explain, ...x }; };
const ITEMS = [['notebook', 3], ['pencil box', 4], ['backpack', 18], ['water bottle', 6], ['sandwich', 5], ['juice', 2], ['toy robot', 15], ['book', 8], ['lunch box', 7], ['football', 12], ['headphones', 20], ['puzzle', 9]];
export const gen = {
  calc(d, r) {
    if (d <= 2) { const p = r.int(2, 9) * d, qn = r.int(2, 5); return { type: 'input', q: `Each ${r.pick(ITEMS)[0]} costs ${f(p)}. How much do ${qn} cost in total? (${cur()})`, answer: p * qn, explain: `${qn} × ${f(p)} = ${f(p * qn)}.` }; }
    const pay = r.pick([20, 50, 100]), cost = r.int(Math.floor(pay / 4), pay - 3) ; return { type: 'input', q: `Your shopping costs ${f(cost)} and you pay with ${f(pay)}. How much change do you get? (${cur()})`, answer: pay - cost, explain: `${f(pay)} − ${f(cost)} = ${f(pay - cost)}.` };
  },
  disc(d, r) {
    const price = r.pick([20, 40, 60, 80, 100, 120, 200]), pct = r.pick(d < 3 ? [10, 50] : [15, 20, 25, 30, 40]);
    const save = (price * pct) / 100;
    if (d <= 3) return { type: 'input', q: `A game costs ${f(price)} and is ${pct}% off. How much do you save? (${cur()})`, answer: save, explain: `${pct}% of ${f(price)} = ${f(save)}.` };
    return mcqNum(`A jacket is ${f(price)} with ${pct}% off. What is the sale price?`, price - save, r, `${f(price)} − ${f(save)} = ${f(price - save)}.`);
  },
  shop(d, r) {
    const a = r.pick(ITEMS), b = r.pick(ITEMS.filter((i) => i[0] !== a[0])), n = r.int(2, 4);
    if (d <= 2) return { type: 'input', q: `A ${a[0]} costs ${f(a[1])} and a ${b[0]} costs ${f(b[1])}. What is the total? (${cur()})`, answer: a[1] + b[1], explain: `${f(a[1])} + ${f(b[1])} = ${f(a[1] + b[1])}.` };
    const pack = n * r.int(2, 9); // pack of n vs single
    return mcqNum(`A pack of ${n} ${a[0]}s costs ${f(pack)}. What is the price of one?`, pack / n, r, `${f(pack)} ÷ ${n} = ${f(pack / n)}.`);
  },
  budget(d, r) { // multi-select budget challenge
    const pool = r.shuffle(ITEMS).slice(0, 5 + (d > 3 ? 1 : 0)); const wallet = pool.slice(0, 3).reduce((s, i) => s + i[1], 0) + r.int(0, 2);
    // Correct set: the three cheapest-style needs that fit in wallet — define by construction: first 3 items = chosen set.
    const need = pool.slice(0, 3); const options = r.shuffle(pool.map((p, i) => ({ t: p[0], price: p[1], need: i < 3 })));
    const answers = options.map((o, i) => (o.need ? i : -1)).filter((i) => i >= 0);
    return { type: 'multi', q: `You have ${f(wallet)}. You MUST buy: ${need.map((n) => n[0]).join(', ')}. Tap exactly those items to check they fit your budget.`, options: options.map((o) => ({ t: o.t, price: o.price })), answers, budget: wallet, cur: cur(), explain: `${need.map((n) => `${n[0]} ${f(n[1])}`).join(' + ')} = ${f(need.reduce((s, n) => s + n[1], 0))}, which fits within ${f(wallet)}.` };
  },
  save(d, r) {
    const goal = r.pick([60, 90, 120, 150, 240]) , week = r.pick([5, 6, 10, 15, 20]).valueOf(); const weeks = Math.ceil(goal / week);
    return { type: 'input', q: `You want to buy something that costs ${f(goal)} and save ${f(week)} each week. How many weeks until you can buy it? (whole weeks)`, answer: weeks, explain: `${f(goal)} ÷ ${f(week)} = ${(goal / week).toFixed(1)} → ${weeks} weeks (round up).` };
  },
};
export const alt = { calc: ['calc', 'shop'], shop: ['shop', 'budget'], budget: ['budget'], disc: ['disc'], save: ['save'] };
export const bank = [
  M('save', 1, 'What is the best reason to save money?', 'To be ready for future needs and goals', ['To spend it all today', 'To show others', 'Saving is never useful'], 'Saving helps you meet goals and handle surprises.', { img: '🐷' }),
  M('save', 2, 'Which usually helps you save more?', 'Saving a part of your money first', ['Saving only what is left over', 'Never checking prices', 'Borrowing to spend'], 'Many people “pay themselves first”.'),
  M('save', 3, 'An emergency fund is money kept for…', 'Unexpected costs', ['Fun shopping', 'Birthday gifts only', 'Stock market bets'], 'It covers surprises like repairs or medical bills.'),
  M('spend', 1, 'Which is a NEED?', 'Food', ['A new video game', 'A fancy toy', 'A movie ticket'], 'Needs are things you must have to live.', { img: '🍎' }),
  S('spend', 2, 'Drag each item into Need or Want.', ['Need', 'Want'], [['Warm coat in winter', 0], ['Drinking water', 0], ['Video game', 1], ['Designer sneakers', 1], ['School books', 0], ['Candy', 1]], 'Needs keep you healthy, safe and learning; wants are nice extras.'),
  M('spend', 3, 'You see an ad for a toy you suddenly want. What is a smart first step?', 'Wait a day and compare prices', ['Buy it immediately', 'Borrow money', 'Ignore your budget'], 'Pausing prevents impulse purchases.'),
  M('shop', 3, 'What is “unit price”?', 'Price per single item or measure', ['Total bill', 'A discount code', 'Tax'], 'Unit price helps compare different pack sizes.'),
  M('budget', 2, 'A budget is…', 'A plan for how to use your money', ['A type of coin', 'A bank loan', 'A shopping bag'], 'A budget tracks income and spending.'),
  M('budget', 3, 'Which is a good budgeting rule of thumb example?', '50% needs, 30% wants, 20% savings', ['100% wants', '90% wants, 10% needs', 'No savings'], 'The 50/30/20 rule is one popular guideline, not advice for everyone.', { certainty: 'debated' }),
  M('plan', 3, 'What does “interest” on a savings account mean?', 'Money the bank pays you for keeping money there', ['A fee you pay', 'A type of coupon', 'A bank holiday'], 'Savings accounts pay interest.'),
  M('plan', 4, 'If you save 100 at 10% simple interest per year, how much interest after 1 year?', '10', ['1', '100', '110'], '10% of 100 is 10 (the total would be 110).'),
  M('lit', 2, 'Which is safe to share with a stranger online?', 'Nothing about your bank details or passwords', ['Your card number', 'Your PIN', 'Your passwords'], 'Never share financial secrets.'),
  M('lit', 3, 'What is inflation?', 'A general rise in prices over time', ['A fall in prices', 'A bank charge', 'A type of tax'], 'With inflation each unit of money buys less.'),
  M('lit', 4, 'What does a “credit” card do?', 'Lets you borrow money that must be repaid', ['Gives free money', 'Never charges interest', 'Replaces savings'], 'Credit is a loan; late repayment can cost interest. This is general education, not financial advice.'),
  M('lit', 5, 'Why is “diversification” often discussed in investing?', 'Spreading money reduces risk from any one investment', ['It guarantees profit', 'It removes all risk', 'It avoids taxes'], 'General education only — not personal financial advice.'),
  M('disc', 2, 'A shirt is 50% off. Compared with the original price, you pay…', 'Half', ['Double', 'A quarter', 'The same'], '50% off means half price.'),
  M('plan', 2, 'What should come first when you set a savings goal?', 'Decide how much you need and by when', ['Spend first', 'Hide the goal', 'Ask a stranger'], 'A clear target and date make saving easier.'),
  U('budget', 3, 'Birthday party budget: you have 30. Tap all items that you can buy together within the budget — cake 12, balloons 6, snacks 10, big speaker 25.', [{ t: 'Cake', price: 12 }, { t: 'Balloons', price: 6 }, { t: 'Snacks', price: 10 }, { t: 'Big speaker', price: 25 }], [0, 1, 2], 'Cake + balloons + snacks = 28, within 30. The speaker would break the budget.', { budget: 30 }),
];
export const boss = { title: 'The Budget Boss', desc: 'Manage a budget through tricky shopping decisions!', count: 4, minD: 3, cats: ['budget', 'shop', 'calc', 'save', 'disc'], types: ['multi', 'input', 'mcq'] };
export const titles = ['Coin Corner', 'Change Counter', 'Savings Street', 'Shopping Mall', 'Discount Depot', 'Needs & Wants Plaza', 'Budget Bridge', 'Planner’s Park', 'Bank Boulevard', 'Skyline Tower'];
