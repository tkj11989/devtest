import { M, O, P, S } from './helpers.js';
export const cats = [
  { id: 'country', name: 'Countries', emoji: '🗺️' }, { id: 'capital', name: 'Capitals', emoji: '🏛️' },
  { id: 'flag', name: 'Flags', emoji: '🚩' }, { id: 'continent', name: 'Continents', emoji: '🌏' },
  { id: 'ocean', name: 'Oceans', emoji: '🌊' }, { id: 'nature', name: 'Mountains & Rivers', emoji: '⛰️' },
  { id: 'landmark', name: 'Landmarks', emoji: '🗽' }, { id: 'directions', name: 'Maps & Directions', emoji: '🧭' },
];
// name, capital, continent, flag, lat, lon (capital), difficulty of recognition
export const COUNTRIES = [
  ['India', 'New Delhi', 'Asia', '🇮🇳', 28.6, 77.2, 1], ['China', 'Beijing', 'Asia', '🇨🇳', 39.9, 116.4, 1], ['Japan', 'Tokyo', 'Asia', '🇯🇵', 35.7, 139.7, 1],
  ['United States', 'Washington, D.C.', 'North America', '🇺🇸', 38.9, -77.0, 1], ['Canada', 'Ottawa', 'North America', '🇨🇦', 45.4, -75.7, 1], ['Mexico', 'Mexico City', 'North America', '🇲🇽', 19.4, -99.1, 2],
  ['Brazil', 'Brasília', 'South America', '🇧🇷', -15.8, -47.9, 1], ['Argentina', 'Buenos Aires', 'South America', '🇦🇷', -34.6, -58.4, 2], ['Peru', 'Lima', 'South America', '🇵🇪', -12.0, -77.0, 3], ['Colombia', 'Bogotá', 'South America', '🇨🇴', 4.7, -74.1, 3],
  ['United Kingdom', 'London', 'Europe', '🇬🇧', 51.5, -0.1, 1], ['France', 'Paris', 'Europe', '🇫🇷', 48.9, 2.35, 1], ['Germany', 'Berlin', 'Europe', '🇩🇪', 52.5, 13.4, 1], ['Italy', 'Rome', 'Europe', '🇮🇹', 41.9, 12.5, 1],
  ['Spain', 'Madrid', 'Europe', '🇪🇸', 40.4, -3.7, 2], ['Portugal', 'Lisbon', 'Europe', '🇵🇹', 38.7, -9.1, 3], ['Greece', 'Athens', 'Europe', '🇬🇷', 38.0, 23.7, 3], ['Russia', 'Moscow', 'Europe', '🇷🇺', 55.8, 37.6, 2],
  ['Sweden', 'Stockholm', 'Europe', '🇸🇪', 59.3, 18.1, 4], ['Norway', 'Oslo', 'Europe', '🇳🇴', 59.9, 10.7, 4],
  ['Egypt', 'Cairo', 'Africa', '🇪🇬', 30.0, 31.2, 2], ['Nigeria', 'Abuja', 'Africa', '🇳🇬', 9.1, 7.5, 3], ['Kenya', 'Nairobi', 'Africa', '🇰🇪', -1.3, 36.8, 3], ['South Africa', 'Pretoria', 'Africa', '🇿🇦', -25.7, 28.2, 3],
  ['Ethiopia', 'Addis Ababa', 'Africa', '🇪🇹', 9.0, 38.7, 4], ['Morocco', 'Rabat', 'Africa', '🇲🇦', 34.0, -6.8, 4],
  ['Australia', 'Canberra', 'Oceania', '🇦🇺', -35.3, 149.1, 1], ['New Zealand', 'Wellington', 'Oceania', '🇳🇿', -41.3, 174.8, 3],
  ['Saudi Arabia', 'Riyadh', 'Asia', '🇸🇦', 24.7, 46.7, 3], ['Turkey', 'Ankara', 'Asia', '🇹🇷', 39.9, 32.9, 3], ['Indonesia', 'Jakarta', 'Asia', '🇮🇩', -6.2, 106.8, 2], ['Thailand', 'Bangkok', 'Asia', '🇹🇭', 13.8, 100.5, 2],
  ['Pakistan', 'Islamabad', 'Asia', '🇵🇰', 33.7, 73.0, 2], ['Nepal', 'Kathmandu', 'Asia', '🇳🇵', 27.7, 85.3, 3], ['South Korea', 'Seoul', 'Asia', '🇰🇷', 37.6, 127.0, 2], ['Vietnam', 'Hanoi', 'Asia', '🇻🇳', 21.0, 105.8, 3],
  ['Bangladesh', 'Dhaka', 'Asia', '🇧🇩', 23.8, 90.4, 3], ['Cuba', 'Havana', 'North America', '🇨🇺', 23.1, -82.4, 4], ['Chile', 'Santiago', 'South America', '🇨🇱', -33.4, -70.7, 3],
].map(([name, capital, continent, flag, lat, lon, d]) => ({ name, capital, continent, flag, lat, lon, d }));
export const LANDMARKS = [
  ['Taj Mahal', 'India', 27.17, 78.04, '🕌', 1], ['Eiffel Tower', 'France', 48.86, 2.29, '🗼', 1], ['Great Wall of China', 'China', 40.43, 116.57, '🧱', 2], ['Pyramids of Giza', 'Egypt', 29.98, 31.13, '🔺', 1],
  ['Statue of Liberty', 'United States', 40.69, -74.04, '🗽', 1], ['Colosseum', 'Italy', 41.89, 12.49, '🏟️', 2], ['Machu Picchu', 'Peru', -13.16, -72.55, '🏔️', 3], ['Sydney Opera House', 'Australia', -33.86, 151.21, '🎭', 2],
  ['Christ the Redeemer', 'Brazil', -22.95, -43.21, '⛪', 2], ['Big Ben', 'United Kingdom', 51.5, -0.12, '🕰️', 2], ['Mount Fuji', 'Japan', 35.36, 138.73, '🗻', 2], ['Petra', 'Jordan', 30.33, 35.44, '🏜️', 4],
  ['Angkor Wat', 'Cambodia', 13.41, 103.87, '🛕', 4], ['Burj Khalifa', 'United Arab Emirates', 25.2, 55.27, '🏙️', 3], ['Stonehenge', 'United Kingdom', 51.18, -1.83, '🪨', 4],
].map(([name, country, lat, lon, emoji, d]) => ({ name, country, lat, lon, emoji, d }));
const tol = [0, 18, 14, 11, 9, 7];
const shuf = (r, a) => r.shuffle(a);
function others(list, item, key, n, r) { return shuf(r, list.filter((x) => x[key] !== item[key])).slice(0, n); }

export const gen = {
  country(d, r) { // map identification
    const pool = COUNTRIES.filter((c) => c.d <= Math.min(5, d + 1)); const c = r.pick(pool);
    return { type: 'map', q: `Where is ${c.name}? Tap the map near its capital, ${c.capital}.`, target: { lat: c.lat, lon: c.lon }, tol: tol[d] ?? 9, label: c.name, explain: `${c.name} is in ${c.continent}; its capital is ${c.capital}.` };
  },
  capital(d, r) {
    const pool = COUNTRIES.filter((c) => c.d <= Math.min(5, d + 1)); const c = r.pick(pool);
    const w = others(COUNTRIES, c, 'capital', 3, r).map((x) => x.capital); const o = shuf(r, [c.capital, ...w]);
    if (d >= 3 && r.chance(0.4)) { const same = COUNTRIES.filter((x) => x.continent === c.continent && x.name !== c.name).slice(0, 3).map((x) => x.capital); const o2 = shuf(r, [c.capital, ...same]); return { type: 'mcq', q: `What is the capital of ${c.name}?`, options: o2, answer: o2.indexOf(c.capital), explain: `The capital of ${c.name} is ${c.capital}.` }; }
    return { type: 'mcq', q: `What is the capital of ${c.name}?`, options: o, answer: o.indexOf(c.capital), explain: `The capital of ${c.name} is ${c.capital}.` };
  },
  flag(d, r) {
    const pool = COUNTRIES.filter((c) => c.d <= Math.min(5, d + 1)); const c = r.pick(pool);
    const w = others(COUNTRIES, c, 'name', 3, r).map((x) => x.name); const o = shuf(r, [c.name, ...w]);
    return { type: 'mcq', q: 'Which country does this flag belong to?', img: c.flag, options: o, answer: o.indexOf(c.name), explain: `${c.flag} is the flag of ${c.name}.` };
  },
  continent(d, r) {
    if (d >= 3) { const cs = shuf(r, COUNTRIES.filter((c) => c.d <= d + 1)); const picks = []; const seen = new Set(); for (const c of cs) { if (!seen.has(c.continent) || picks.length >= 4) { picks.push(c); seen.add(c.continent); } if (picks.length === 6) break; }
      const buckets = [...new Set(picks.map((p) => p.continent))].slice(0, 3); const items = picks.filter((p) => buckets.includes(p.continent)).map((p) => [p.name, buckets.indexOf(p.continent)]);
      return { type: 'sort', q: 'Drag each country onto its continent.', buckets, items, explain: items.map((i) => `${i[0]} → ${buckets[i[1]]}`).join('; ') + '.' }; }
    const c = r.pick(COUNTRIES.filter((x) => x.d <= d + 1)); const conts = ['Asia', 'Africa', 'Europe', 'North America', 'South America', 'Oceania'];
    const o = shuf(r, [c.continent, ...shuf(r, conts.filter((x) => x !== c.continent)).slice(0, 3)]);
    return { type: 'mcq', q: `${c.name} is in which continent?`, img: c.flag, options: o, answer: o.indexOf(c.continent), explain: `${c.name} is in ${c.continent}.` };
  },
  landmark(d, r) {
    const pool = LANDMARKS.filter((l) => l.d <= Math.min(5, d + 1)); const l = r.pick(pool);
    if (r.chance(0.5)) return { type: 'map', q: `Find the ${l.name}. Tap where it is.`, target: { lat: l.lat, lon: l.lon }, tol: tol[d] ?? 9, label: l.name, explain: `The ${l.name} is in ${l.country}.` };
    const w = others(LANDMARKS, l, 'country', 3, r).map((x) => x.country); const o = shuf(r, [l.country, ...w]);
    return { type: 'mcq', q: `In which country is the ${l.name}?`, img: l.emoji, options: o, answer: o.indexOf(l.country), explain: `The ${l.name} is in ${l.country}.` };
  },
  matchCap(d, r) {
    const cs = shuf(r, COUNTRIES.filter((c) => c.d <= Math.min(5, d + 1))).slice(0, 4);
    return { type: 'match', q: 'Match each country to its capital.', pairs: cs.map((c) => [c.name, c.capital]), explain: cs.map((c) => `${c.name} – ${c.capital}`).join('; ') + '.' };
  },
};
export const alt = { country: ['country'], capital: ['capital', 'matchCap'], flag: ['flag'], continent: ['continent'], landmark: ['landmark'] };
export const bank = [
  M('ocean', 1, 'Which is the largest ocean on Earth?', 'Pacific Ocean', ['Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'], 'The Pacific covers about a third of Earth’s surface.', { img: '🌊' }),
  M('ocean', 2, 'Which ocean lies between Africa and Australia, south of India?', 'Indian Ocean', ['Atlantic Ocean', 'Pacific Ocean', 'Southern Ocean'], 'India gave its name to the Indian Ocean.'),
  M('ocean', 3, 'Which ocean is the smallest?', 'Arctic Ocean', ['Indian Ocean', 'Southern Ocean', 'Atlantic Ocean'], 'The Arctic Ocean is the smallest and shallowest.'),
  M('ocean', 4, 'Which sea is the lowest-lying and saltiest large inland sea, bordering Israel and Jordan?', 'Dead Sea', ['Red Sea', 'Black Sea', 'Caspian Sea'], 'Its shore is the lowest land elevation on Earth.'),
  M('ocean', 2, 'How many oceans are commonly recognised today?', 'Five', ['Three', 'Four', 'Seven'], 'Pacific, Atlantic, Indian, Southern and Arctic (the Southern Ocean is recognised by many bodies).', { certainty: 'debated' }),
  M('nature', 1, 'What is the highest mountain above sea level?', 'Mount Everest', ['K2', 'Mont Blanc', 'Kilimanjaro'], 'Everest is about 8,849 m high.', { img: '🏔️' }),
  M('nature', 2, 'Which river is famous for flowing through Egypt?', 'Nile', ['Amazon', 'Ganges', 'Danube'], 'The Nile flows north through Egypt to the Mediterranean.'),
  M('nature', 2, 'Which Indian river is considered holy and flows through Varanasi?', 'Ganges (Ganga)', ['Godavari', 'Narmada', 'Krishna'], 'Varanasi sits on the Ganges.'),
  M('nature', 3, 'Which river carries the largest volume of water in the world?', 'Amazon', ['Nile', 'Yangtze', 'Mississippi'], 'The Amazon discharges more water than any other river.'),
  M('nature', 3, 'Which mountain range separates Europe from Asia in Russia?', 'Ural Mountains', ['Alps', 'Andes', 'Rockies'], 'The Urals form part of the conventional boundary.'),
  M('nature', 4, 'The Himalayas formed mainly from the collision of which two plates?', 'Indian and Eurasian plates', ['African and South American', 'Pacific and Nazca', 'Antarctic and Australian'], 'The Indian plate is still pushing north.'),
  M('nature', 4, 'Which is the longest river in India?', 'Ganges (Ganga)', ['Yamuna', 'Brahmaputra', 'Godavari'], 'The Ganga is generally cited as the longest river flowing within India (~2,500 km).', { certainty: 'debated' }),
  M('nature', 5, 'Which mountain range runs along the western edge of South America?', 'Andes', ['Alps', 'Atlas', 'Appalachians'], 'The Andes are the longest continental mountain range.'),
  M('continent', 1, 'How many continents are there (in the most common model)?', 'Seven', ['Five', 'Six', 'Eight'], 'Asia, Africa, North America, South America, Antarctica, Europe, Australia/Oceania.', { certainty: 'debated' }),
  M('continent', 1, 'Which is the largest continent?', 'Asia', ['Africa', 'Europe', 'North America'], 'Asia covers about 30% of land area.'),
  M('continent', 2, 'Which continent is entirely south of the Antarctic Circle?', 'Antarctica', ['Australia', 'South America', 'Africa'], 'It is the southernmost continent.'),
  M('continent', 3, 'The Sahara Desert is in which continent?', 'Africa', ['Asia', 'Australia', 'South America'], 'It stretches across North Africa.'),
  S('continent', 2, 'Sort each landmark into its continent.', ['Africa', 'Europe', 'Asia'], [['Pyramids of Giza', 0], ['Eiffel Tower', 1], ['Taj Mahal', 2], ['Colosseum', 1], ['Mount Kilimanjaro', 0], ['Great Wall', 2]], 'Pyramids/Kilimanjaro are in Africa; Eiffel/Colosseum in Europe; Taj Mahal/Great Wall in Asia.'),
  M('directions', 1, 'On a map, which direction is usually at the top?', 'North', ['South', 'East', 'West'], 'Maps are normally oriented with north up.', { img: '🧭' }),
  M('directions', 2, 'If you face north and turn right, which way are you facing?', 'East', ['West', 'South', 'North'], 'Clockwise from north is east.'),
  M('directions', 2, 'What is the opposite of north-east?', 'South-west', ['North-west', 'South-east', 'West'], 'Opposite directions are 180° apart.'),
  M('directions', 3, 'Lines of latitude run in which direction?', 'East–west (parallel to the equator)', ['North–south', 'Diagonal', 'In circles around the poles only'], 'Latitudes are parallel horizontal lines.'),
  M('directions', 3, 'What is the latitude of the Equator?', '0°', ['23.5°', '90°', '180°'], 'The Equator is 0° latitude.'),
  M('directions', 4, 'The Prime Meridian passes through which city?', 'Greenwich (London)', ['Paris', 'Cairo', 'New Delhi'], 'It is 0° longitude.'),
  M('directions', 5, 'Which tropic passes through the middle of India?', 'Tropic of Cancer', ['Tropic of Capricorn', 'Arctic Circle', 'Equator'], 'The Tropic of Cancer (~23.5° N) crosses central India.'),
  M('country', 2, 'Which is the largest country by area?', 'Russia', ['Canada', 'China', 'United States'], 'Russia is about 17 million km².'),
  M('country', 2, 'Which country is also a continent?', 'Australia', ['Greenland', 'Iceland', 'Japan'], 'Australia is a country on the continent of Australia/Oceania.'),
  M('country', 3, 'Which is the most populous country in the world today?', 'India', ['China', 'United States', 'Indonesia'], 'India overtook China around 2023 according to UN estimates.', { certainty: 'debated' }),
  M('country', 4, 'Which country has the most time zones including overseas territories?', 'France', ['Russia', 'United States', 'United Kingdom'], 'France has 12 time zones counting overseas territories.', { certainty: 'debated' }),
  M('landmark', 3, 'Which structure lies in India and was built by Shah Jahan?', 'Taj Mahal', ['Qutub Minar', 'Hawa Mahal', 'Gateway of India'], 'Shah Jahan built it for Mumtaz Mahal.', { img: '🕌' }),
];
export const boss = { title: 'The Map Maker’s Race', desc: 'Find 8 locations on the map before time runs out!', count: 8, minD: 3, cats: ['country', 'landmark'], types: ['map'], time: 100 };
export const titles = ['Compass Cove', 'Capital Coast', 'Flag Fields', 'Continent Canyon', 'Ocean Odyssey', 'Mountain Trail', 'Landmark Lane', 'Direction Dunes', 'Country Crossing', 'Explorer’s Summit'];
export const MAP = {
  land: [
    [[-168, 66], [-140, 70], [-120, 72], [-95, 72], [-80, 70], [-62, 60], [-55, 50], [-67, 45], [-76, 35], [-81, 25], [-97, 26], [-97, 18], [-87, 21], [-83, 10], [-78, 8], [-92, 15], [-105, 20], [-115, 30], [-124, 40], [-125, 49], [-135, 58], [-150, 60], [-165, 60]],
    [[-55, 60], [-45, 60], [-20, 70], [-20, 82], [-60, 82], [-72, 76]],
    [[-78, 8], [-72, 12], [-62, 10], [-50, 0], [-35, -5], [-39, -15], [-48, -26], [-58, -38], [-65, -42], [-68, -55], [-75, -50], [-73, -37], [-71, -18], [-81, -5]],
    [[-10, 36], [-9, 43], [-2, 48], [2, 51], [8, 54], [10, 58], [5, 62], [15, 69], [30, 71], [40, 66], [40, 55], [30, 46], [28, 41], [23, 36], [15, 38], [8, 44], [3, 42]],
    [[-17, 21], [-10, 35], [10, 37], [32, 31], [35, 28], [43, 12], [51, 12], [40, -5], [40, -15], [35, -25], [20, -35], [15, -28], [12, -5], [9, 4], [-8, 4], [-17, 14]],
    [[30, 46], [40, 55], [40, 66], [60, 70], [100, 77], [140, 72], [180, 68], [170, 60], [140, 52], [135, 44], [122, 40], [122, 30], [120, 22], [108, 18], [106, 10], [100, 2], [98, 15], [92, 22], [80, 8], [73, 20], [67, 25], [57, 25], [52, 29], [45, 30], [35, 36], [28, 41]],
    [[35, 28], [48, 30], [56, 26], [59, 22], [52, 16], [43, 12], [39, 21]],
    [[114, -22], [122, -18], [131, -12], [137, -12], [142, -11], [146, -19], [153, -26], [150, -37], [140, -38], [130, -32], [115, -34]],
    [[172, -35], [178, -38], [175, -41], [167, -46], [171, -42]],
    [[130, 32], [136, 35], [141, 41], [142, 45], [140, 37], [132, 31]],
    [[-6, 50], [2, 52], [-3, 58], [-6, 56]],
    [[95, 5], [105, -6], [120, -9], [140, -8], [150, -8], [130, -2], [118, 2], [108, 1]],
    [[-180, -70], [-120, -75], [-60, -75], [0, -70], [60, -68], [120, -66], [180, -70], [180, -90], [-180, -90]],
  ],
};
