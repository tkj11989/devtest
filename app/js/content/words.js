import { M, I, O } from './helpers.js';

export const cats = [
  { id: 'vocab', name: 'Vocabulary', emoji: '📖' },
  { id: 'spell', name: 'Spelling', emoji: '✏️' },
  { id: 'grammar', name: 'Grammar', emoji: '🧾' },
  { id: 'sentence', name: 'Sentence Building', emoji: '🧱' },
  { id: 'syn', name: 'Synonyms & Antonyms', emoji: '🔁' },
  { id: 'relation', name: 'Word Relationships', emoji: '🔗' },
  { id: 'missing', name: 'Missing Words', emoji: '🕳️' },
  { id: 'correct', name: 'Sentence Correction', emoji: '🛠️' },
  { id: 'idiom', name: 'Idioms', emoji: '💬' },
];

// word, definition, difficulty
const V = [
  ['happy', 'feeling joy', 1], ['enormous', 'extremely large', 1], ['rapid', 'very fast', 1], ['brave', 'ready to face danger', 1],
  ['ancient', 'very old', 2], ['fragile', 'easily broken', 2], ['curious', 'eager to learn or know', 2], ['generous', 'happy to give and share', 2],
  ['reluctant', 'unwilling or hesitant', 3], ['abundant', 'existing in large quantities', 3], ['persuade', 'to convince someone to do something', 3], ['vacant', 'empty; not occupied', 3],
  ['meticulous', 'showing great attention to detail', 4], ['benevolent', 'kind and well-meaning', 4], ['ephemeral', 'lasting a very short time', 4], ['candid', 'honest and straightforward', 4],
  ['ubiquitous', 'present everywhere', 5], ['ambiguous', 'having more than one possible meaning', 5], ['pragmatic', 'dealing with things sensibly and realistically', 5], ['eloquent', 'fluent and persuasive in speaking', 5],
];
// [word, synonym, antonym, d]
const SA = [
  ['big', 'large', 'small', 1], ['quick', 'fast', 'slow', 1], ['hot', 'warm', 'cold', 1], ['begin', 'start', 'end', 1],
  ['smart', 'clever', 'foolish', 2], ['tired', 'weary', 'energetic', 2], ['difficult', 'hard', 'easy', 2], ['silent', 'quiet', 'noisy', 2],
  ['ancient', 'old', 'modern', 3], ['plentiful', 'abundant', 'scarce', 3], ['fortunate', 'lucky', 'unlucky', 3], ['ally', 'partner', 'enemy', 3],
  ['diligent', 'hardworking', 'lazy', 4], ['frugal', 'thrifty', 'wasteful', 4], ['obscure', 'unclear', 'clear', 4], ['transparent', 'see-through', 'opaque', 4],
  ['mundane', 'ordinary', 'extraordinary', 5], ['lucid', 'clear', 'confusing', 5], ['zenith', 'peak', 'bottom', 5], ['scrutinise', 'examine closely', 'ignore', 5],
];
const SPELL = [
  ['because', ['becuase', 'becase', 'becouse'], 1], ['friend', ['freind', 'frend', 'friand'], 1], ['beautiful', ['beutiful', 'beautifull', 'butiful'], 2],
  ['different', ['diffrent', 'diferent', 'differant'], 2], ['necessary', ['neccessary', 'necesary', 'neccesary'], 3], ['separate', ['seperate', 'seprate', 'separete'], 3],
  ['definitely', ['definately', 'definitly', 'defanitely'], 3], ['receive', ['recieve', 'receeve', 'receve'], 3], ['embarrass', ['embarass', 'embarrase', 'embarras'], 4],
  ['accommodate', ['accomodate', 'acommodate', 'accomadate'], 4], ['conscience', ['concience', 'consience', 'conscients'], 5], ['occurrence', ['occurence', 'ocurrence', 'occurrance'], 5],
  ['rhythm', ['rythm', 'rhythem', 'rhythym'], 5], ['library', ['libary', 'liberry', 'librery'], 2], ['february', ['febuary', 'feburary', 'febrary'], 4],
].map(([a, w, d]) => M('spell', d, 'Which spelling is correct?', a, w, `The correct spelling is “${a}”.`));
const GR = [
  [1, 'She ___ to school every day.', 'goes', ['go', 'going', 'gone'], 'With “she” (third person singular) we add -es: she goes.'],
  [1, 'They ___ playing in the garden.', 'are', ['is', 'am', 'be'], '“They” is plural, so we use “are”.'],
  [1, 'I have ___ apple.', 'an', ['a', 'the apples', 'two an'], 'Use “an” before a vowel sound.'],
  [2, 'Yesterday we ___ to the museum.', 'went', ['go', 'gone', 'goes'], 'Yesterday signals past simple: went.'],
  [2, 'He is taller ___ his brother.', 'than', ['then', 'that', 'as'], 'Use “than” to compare.'],
  [2, 'There ___ three books on the shelf.', 'are', ['is', 'was', 'be'], 'Plural “three books” takes “are”.'],
  [3, 'If it rains, we ___ stay inside.', 'will', ['would have', 'did', 'are'], 'First conditional: if + present, will + verb.'],
  [3, 'Neither of the boys ___ ready.', 'was', ['were', 'are', 'have'], '“Neither” takes a singular verb.'],
  [3, 'She has lived here ___ 2015.', 'since', ['for', 'from', 'during'], '“Since” is used with a starting point in time.'],
  [4, 'The team ___ celebrating its victory.', 'is', ['are', 'were', 'have'], 'A team acting as one unit takes a singular verb (in standard British & American usage).'],
  [4, 'Had I known, I ___ come earlier.', 'would have', ['will have', 'would', 'had'], 'Third conditional (inverted): had + past perfect, would have + past participle.'],
  [4, 'She asked me ___ I was going.', 'where', ['that', 'what', 'which'], 'Indirect question: “where I was going”.'],
  [5, 'Not only ___ he late, but he also forgot his keys.', 'was', ['is he', 'he was', 'were'], 'After “Not only” at the start, we invert: was he… (“Not only was he late”).'],
  [5, 'The data ___ collected over three years.', 'were', ['was', 'is', 'has'], '“Data” is formally plural (datum); “was” is also widely used informally.', 'debated'],
  [5, 'She suggested that he ___ the doctor.', 'see', ['sees', 'saw', 'seeing'], 'After “suggest that”, the subjunctive uses the base form: that he see.'],
];
const MISS = [
  [1, 'The sun rises in the ___.', 'east', ['west', 'north', 'moon'], 'The sun rises in the east.'],
  [1, 'A baby cat is called a ___.', 'kitten', ['puppy', 'calf', 'cub'], 'A baby cat is a kitten.'],
  [2, 'We use an ___ when it rains.', 'umbrella', ['umpire', 'ulcer', 'uncle'], 'An umbrella keeps rain off.'],
  [2, 'The ___ of the story was very exciting.', 'ending', ['endure', 'ender', 'endless'], '“Ending” is the noun that fits.'],
  [3, 'She was ___ by the sudden loud noise. (frightened)', 'startled', ['startle', 'starting', 'starter'], 'Past participle “startled” is needed after “was”.'],
  [4, 'The scientist made a ___ discovery that changed medicine.', 'groundbreaking', ['groundwork', 'grounded', 'groundless'], 'Groundbreaking means new and highly influential.'],
  [5, 'His ___ remarks left the audience uncertain what he really meant.', 'ambiguous', ['ambitious', 'ambient', 'amiable'], 'Ambiguous = can be understood in more than one way.'],
];
const CORR = [
  [1, 'Choose the correct sentence.', 'She doesn’t like apples.', ['She don’t like apples.', 'She not like apples.', 'She no likes apples.'], 'With “she”, use “doesn’t”.'],
  [1, 'Choose the correct sentence.', 'My brother has two dogs.', ['My brother have two dogs.', 'My brother having two dogs.', 'My brothers has two dog.'], 'Singular subject “brother” → “has”.'],
  [2, 'Choose the correct sentence.', 'I saw him yesterday.', ['I seen him yesterday.', 'I have saw him yesterday.', 'I see him yesterday.'], 'Simple past of “see” is “saw”.'],
  [2, 'Choose the correct sentence.', 'Their house is bigger than ours.', ['There house is bigger than ours.', 'Their house is more bigger than ours.', 'They’re house is bigger than ours.'], '“Their” shows possession; “bigger” already comparative.'],
  [3, 'Choose the correct sentence.', 'Each of the students has a book.', ['Each of the students have a book.', 'Each of the student has a book.', 'Each of the students having a book.'], '“Each” takes a singular verb.'],
  [3, 'Choose the correct sentence.', 'Whom did you invite?', ['Who did you invited?', 'Whom you did invite?', 'Whom did you invited?'], 'After “did”, use the base verb: invite.'],
  [4, 'Choose the correct sentence.', 'Despite the rain, we went out.', ['Despite of the rain, we went out.', 'Despite the rain, we going out.', 'In spite the rain, we went out.'], '“Despite” is never followed by “of”.'],
  [4, 'Choose the correct sentence.', 'The number of students has increased.', ['The number of students have increased.', 'The numbers of student has increased.', 'The number of students are increased.'], '“The number of…” takes a singular verb.'],
  [5, 'Choose the correct sentence.', 'Having finished the work, she went home.', ['Having finished the work, the bus took her home.', 'Having finish the work, she went home.', 'Finished the work, she go home.'], 'The participle phrase must describe the subject “she” (no dangling modifier).'],
  [5, 'Choose the correct sentence.', 'If I were you, I would apologise.', ['If I was you, I will apologise.', 'If I am you, I would apologise.', 'If I were you, I will apologised.'], 'Hypothetical (second conditional) uses “were” and “would”.'],
  [3, 'Choose the correct sentence.', 'He gave the book to Sam and me.', ['He gave the book to Sam and I.', 'He give the book to Sam and me.', 'He gave the book for Sam and I.'], 'After a preposition use the object pronoun: me.'],
  [2, 'Choose the correct sentence.', 'We were late because the bus broke down.', ['We was late because the bus broke down.', 'We were late because the bus breaked down.', 'We are late because the bus broke down yesterday.'], '“We were”; the past of “break” is “broke”.'],
];
const IDIOMS = [
  [1, 'break the ice', 'start a conversation in a friendly way', ['break something frozen', 'be very cold', 'stop talking']],
  [1, 'a piece of cake', 'something very easy', ['a dessert', 'a small piece', 'a birthday']],
  [2, 'under the weather', 'feeling slightly ill', ['standing in the rain', 'very happy', 'in a hurry']],
  [2, 'once in a blue moon', 'very rarely', ['every month', 'at night', 'when it is cold']],
  [3, 'let the cat out of the bag', 'reveal a secret by accident', ['free a pet', 'make a mistake', 'go shopping']],
  [3, 'hit the nail on the head', 'describe exactly what is true', ['hurt yourself', 'build a house', 'be angry']],
  [4, 'bite the bullet', 'face a hard situation bravely', ['be hungry', 'be rude', 'make a quick decision about food']],
  [4, 'the ball is in your court', 'it is your turn to decide or act', ['play tennis', 'you are in trouble', 'you won the game']],
  [5, 'burn the midnight oil', 'work late into the night', ['waste fuel', 'cook at night', 'start a fire']],
  [5, 'a blessing in disguise', 'something good that seemed bad at first', ['a hidden gift', 'a costume', 'a religious event']],
];
const REL = [
  [1, 'Hot is to cold as up is to ___.', 'down', ['high', 'tall', 'sun'], 'Opposites: hot–cold, up–down.'],
  [1, 'Bird is to nest as bee is to ___.', 'hive', ['honey', 'flower', 'wing'], 'A nest is a bird’s home; a hive is a bee’s home.'],
  [2, 'Pen is to write as knife is to ___.', 'cut', ['sharp', 'kitchen', 'fork'], 'The tool and what it does.'],
  [2, 'Puppy is to dog as kitten is to ___.', 'cat', ['mouse', 'milk', 'tiger'], 'Young animal and its adult.'],
  [3, 'Doctor is to hospital as teacher is to ___.', 'school', ['book', 'student', 'chalk'], 'A worker and where they work.'],
  [3, 'Chapter is to book as scene is to ___.', 'play', ['actor', 'stage', 'paper'], 'A part and the whole.'],
  [4, 'Drought is to water as famine is to ___.', 'food', ['hunger', 'rain', 'farmer'], 'Both mean a severe shortage.'],
  [4, 'Author is to novel as composer is to ___.', 'symphony', ['orchestra', 'concert', 'piano'], 'Creator and creation.'],
  [5, 'Verbose is to concise as lavish is to ___.', 'frugal', ['rich', 'generous', 'expensive'], 'Verbose/concise and lavish/frugal are opposites.'],
  [5, 'Candle is to wax as pencil is to ___.', 'graphite', ['wood', 'paper', 'eraser'], 'Material that does the main work (wax burns, graphite marks).'],
];
const SENT = [
  [1, ['The', 'cat', 'sat', 'on', 'the', 'mat']], [1, ['I', 'like', 'to', 'read', 'books']], [1, ['We', 'play', 'in', 'the', 'park']],
  [2, ['The', 'brave', 'knight', 'saved', 'the', 'village']], [2, ['She', 'always', 'brushes', 'her', 'teeth', 'before', 'bed']],
  [3, ['After', 'the', 'rain', 'stopped,', 'we', 'went', 'outside']], [3, ['The', 'library', 'opens', 'at', 'nine', 'every', 'morning']],
  [4, ['Although', 'it', 'was', 'late,', 'she', 'finished', 'her', 'homework']], [4, ['The', 'wizard', 'who', 'lives', 'upstairs', 'is', 'very', 'wise']],
  [5, ['Had', 'we', 'left', 'earlier,', 'we', 'would', 'have', 'caught', 'the', 'train']], [5, ['Not', 'only', 'did', 'she', 'win,', 'but', 'she', 'also', 'broke', 'the', 'record']],
];
const SCRAMBLE = [
  ['castle', 'a big stone building for kings', 1], ['planet', 'Earth is one', 1], ['garden', 'a place with flowers', 1], ['dragon', 'a fire-breathing creature', 2],
  ['library', 'a place full of books', 2], ['journey', 'a long trip', 2], ['mystery', 'something hard to explain', 3], ['treasure', 'hidden gold and gems', 3],
  ['adventure', 'an exciting experience', 3], ['knowledge', 'what you gain by learning', 4], ['courageous', 'brave', 4], ['imagination', 'ability to picture new ideas', 5], ['extraordinary', 'beyond the ordinary', 5],
];

export const bank = [];
V.forEach(([w, def, d]) => bank.push(M('vocab', d, `What does “${w}” mean?`, def, V.filter((v) => v[0] !== w).map((v) => v[1]).filter((_, i) => i % 5 === (w.length % 5)).slice(0, 3), `${w} = ${def}.`, { autoWrong: true })));
SA.forEach(([w, s, a, d]) => {
  bank.push(M('syn', d, `Which word is closest in meaning to “${w}”?`, s, SA.filter((x) => x[0] !== w).map((x) => x[2]).slice(w.length % 4).slice(0, 3), `“${s}” is a synonym of “${w}”.`));
  bank.push(M('syn', Math.min(5, d + (d < 3 ? 0 : 0)), `Which word is the opposite of “${w}”?`, a, SA.filter((x) => x[0] !== w).map((x) => x[1]).slice(w.length % 4).slice(0, 3), `“${a}” is an antonym of “${w}”.`));
});
bank.push(...SPELL);
GR.forEach(([d, q, a, w, e, cert]) => bank.push(M('grammar', d, q, a, w, e, { instr: 'Fill in the blank', ...(cert ? { certainty: cert } : {}) })));
MISS.forEach(([d, q, a, w, e]) => bank.push(M('missing', d, q, a, w, e, { instr: 'Find the missing word' })));
CORR.forEach(([d, q, a, w, e]) => bank.push(M('correct', d, q, a, w, e, { instr: 'Restore the magical library by fixing the sentence' })));
IDIOMS.forEach(([d, id, m, w]) => bank.push(M('idiom', d, `What does the idiom “${id}” mean?`, m, w, `“${id}” means ${m}.`)));
REL.forEach(([d, q, a, w, e]) => bank.push(M('relation', d, q, a, w, e)));
SENT.forEach(([d, words]) => bank.push(O('sentence', d, 'Build the sentence: tap the words in the correct order.', words, `Correct sentence: “${words.join(' ')}”.`, { tile: 'word', sentence: true })));
// Correction as typed fix for hard questions
bank.push(I('correct', 4, 'Type the one word that must change to fix this sentence: “She go to school every day.” (Write the corrected word)', 'goes', '“She” needs “goes”.', { accept: ['goes'] }));
bank.push(I('correct', 3, 'Fix the mistake. Type the correct word: “Me and him are friends.” → “He and ___ are friends.”', 'I', 'Subject pronoun: “He and I”.', { accept: ['i'] }));
bank.push(I('missing', 2, 'Type the missing word: “An ___ a day keeps the doctor away.”', 'apple', 'Familiar proverb: an apple a day keeps the doctor away.', { accept: ['apple'] }));

// Generators ---------------------------------------------------------------
export const gen = {
  spell(d, r) { // unscramble letters
    const pool = SCRAMBLE.filter((s) => Math.abs(s[2] - d) <= 1); const [w, clue] = r.pick(pool.length ? pool : SCRAMBLE);
    let letters = r.shuffle(w.split('')); let t = 0; while (letters.join('') === w && t++ < 5) letters = r.shuffle(w.split(''));
    return { type: 'order', q: `Rearrange the letters to make a word. Clue: ${clue}`, items: w.split(''), shuffled: letters, tile: 'letter', explain: `The word is “${w}”.` };
  },
  vocab(d, r) { // hidden word hunt
    const pool = SCRAMBLE.filter((s) => s[0].length <= 8 && Math.abs(s[2] - d) <= 2); const [w, clue] = r.pick(pool);
    const N = Math.max(6, w.length); const grid = Array.from({ length: N * N }, () => String.fromCharCode(97 + r.int(0, 25)));
    const horiz = r.chance(0.5); const row = r.int(0, N - 1), col = r.int(0, N - w.length);
    const cells = [];
    for (let i = 0; i < w.length; i++) { const rr = horiz ? row : i, cc = horiz ? col + i : row; const idx = rr * N + cc; grid[idx] = w[i]; cells.push(idx); }
    return { type: 'hunt', q: `Find the hidden word in the grid. Clue: ${clue} (${w.length} letters)`, grid, n: N, cells, word: w, explain: `The hidden word was “${w}”.` };
  },
};
export const alt = { spell: ['spell', 'spell'], vocab: ['vocab'] };
export const hasBankForCat = (cat) => bank.some((b) => b.cat === cat);
export const boss = { title: 'The Grammar Goblin', desc: 'Correct 6 sentences to restore the magical library!', count: 6, minD: 3, cats: ['correct', 'grammar'] };
export const titles = ['Word Woods', 'Letter Lake', 'Sentence Stones', 'Synonym Stream', 'Spelling Spring', 'Grammar Grove', 'Idiom Island', 'Missing Word Meadow', 'Library Lobby', 'Enchanted Archive'];
