// Demo data. Every ground is owned by OWNER_PHONE so that number can sign in
// and use the stadium-owner dashboard.
const OWNER_PHONE = process.env.OWNER_PHONE || '9000000001';

const sports = [
  { id: 'cricket', name: 'Cricket', icon: '🏏', code: 'CG' },
  { id: 'football', name: 'Football', icon: '⚽', code: 'FB' },
  { id: 'badminton', name: 'Badminton', icon: '🏸', code: 'BD' },
  { id: 'tennis', name: 'Tennis', icon: '🎾', code: 'TN' },
  { id: 'basketball', name: 'Basketball', icon: '🏀', code: 'BB' },
];

const cities = [
  { id: 'jaipur', name: 'Jaipur', state: 'Rajasthan', lat: 26.9124, lng: 75.7873 },
  { id: 'delhi', name: 'Delhi', state: 'Delhi', lat: 28.6139, lng: 77.209 },
];

const hourlySlots = (open, close, price) =>
  Array.from({ length: close - open }, (_, i) => ({ startHour: open + i, price }));

const g = (o) => ({
  ownerPhone: OWNER_PHONE,
  floodlights: true,
  amenities: ['turf', 'floodlights', 'parking', 'washroom', 'seating'],
  slots: hourlySlots(o.open ?? 6, o.close ?? 23, o.price),
  ...o,
});

const grounds = [
  g({ id: 'playon-cricket-arena', sportId: 'cricket', type: 'Turf', name: 'PlayOn Cricket Arena', city: 'jaipur', area: 'Mansarovar', lat: 26.8505, lng: 75.7628, rating: 4.8, reviewCount: 120, price: 1500,
    about: 'Premium cricket turf with floodlights, nets and comfortable seating. Ideal for casual and tournament matches.' }),
  g({ id: 'green-turf-stadium', sportId: 'cricket', type: 'Stadium', name: 'Green Turf Stadium', city: 'jaipur', area: 'Vaishali Nagar', lat: 26.9115, lng: 75.7413, rating: 4.6, reviewCount: 98, price: 1800,
    about: 'Full-size stadium ground with a well-kept centre pitch, pavilion seating and scoreboard. Great for 11-a-side games.' }),
  g({ id: 'royal-cricket-turf', sportId: 'cricket', type: 'Turf', name: 'Royal Cricket Turf', city: 'jaipur', area: 'Malviya Nagar', lat: 26.8549, lng: 75.8243, rating: 4.4, reviewCount: 75, price: 1200,
    about: 'Box-cricket turf with soft artificial grass, side nets and bright LED floodlights for night games.' }),
  g({ id: 'city-sports-ground', sportId: 'cricket', type: 'Stadium', name: 'City Sports Ground', city: 'jaipur', area: 'Jagatpura', lat: 26.8286, lng: 75.854, rating: 4.5, reviewCount: 60, price: 1600,
    about: 'Spacious multi-purpose stadium with a turf pitch, practice nets and ample parking.' }),
  g({ id: 'smash-box-indoor', sportId: 'cricket', type: 'Indoor', name: 'Smash Box Indoor Cricket', city: 'jaipur', area: 'C-Scheme', lat: 26.9076, lng: 75.804, rating: 4.3, reviewCount: 41, price: 1000, floodlights: false,
    amenities: ['turf', 'washroom', 'seating', 'ac'], about: 'Air-conditioned indoor box cricket — play any time, rain or shine.' }),
  g({ id: 'kickoff-arena', sportId: 'football', type: 'Turf', name: 'Kickoff 5-a-side Arena', city: 'jaipur', area: 'Mansarovar', lat: 26.8532, lng: 75.7681, rating: 4.7, reviewCount: 88, price: 1500,
    about: 'FIFA-quality artificial turf for 5-a-side football with floodlights and changing rooms.' }),
  g({ id: 'goal-zone', sportId: 'football', type: 'Stadium', name: 'Goal Zone 7-a-side', city: 'jaipur', area: 'Vaishali Nagar', lat: 26.9142, lng: 75.7455, rating: 4.5, reviewCount: 52, price: 2000,
    about: 'Large 7-a-side pitch with goalposts, nets and spectator seating.' }),
  g({ id: 'shuttle-hub', sportId: 'badminton', type: 'Indoor', name: 'Shuttle Hub', city: 'jaipur', area: 'Raja Park', lat: 26.8946, lng: 75.8296, rating: 4.6, reviewCount: 134, price: 400, floodlights: false, open: 6, close: 22,
    amenities: ['wooden court', 'washroom', 'parking', 'ac'], about: 'Synthetic-mat badminton courts with BWF-standard lighting and air conditioning.' }),
  g({ id: 'smash-point', sportId: 'badminton', type: 'Indoor', name: 'Smash Point Courts', city: 'jaipur', area: 'Malviya Nagar', lat: 26.8571, lng: 75.8201, rating: 4.2, reviewCount: 37, price: 450, floodlights: false, open: 6, close: 22,
    amenities: ['wooden court', 'washroom', 'parking'], about: 'Two wooden badminton courts with racket rental available.' }),
  g({ id: 'ace-tennis-club', sportId: 'tennis', type: 'Stadium', name: 'Ace Tennis Club', city: 'jaipur', area: 'Civil Lines', lat: 26.903, lng: 75.786, rating: 4.5, reviewCount: 46, price: 800, close: 21,
    about: 'Hard courts with floodlights, coaching on request and a members lounge.' }),
  g({ id: 'hoops-court', sportId: 'basketball', type: 'Stadium', name: 'Hoops Court', city: 'jaipur', area: 'Jagatpura', lat: 26.8301, lng: 75.8502, rating: 4.4, reviewCount: 29, price: 700, close: 22,
    about: 'Full-size outdoor basketball court with acrylic surface and glass backboards.' }),
  g({ id: 'capital-cricket-ground', sportId: 'cricket', type: 'Stadium', name: 'Capital Cricket Ground', city: 'delhi', area: 'Dwarka', lat: 28.5921, lng: 77.046, rating: 4.6, reviewCount: 210, price: 2000,
    about: 'Professional cricket ground with turf wickets, sight screens and a pavilion.' }),
  g({ id: 'delhi-turf-club', sportId: 'cricket', type: 'Turf', name: 'Delhi Turf Club', city: 'delhi', area: 'Saket', lat: 28.5245, lng: 77.2066, rating: 4.4, reviewCount: 93, price: 1800,
    about: 'Rooftop box-cricket turf with floodlights in the heart of South Delhi.' }),
].map(({ price, open, close, ...rest }) => rest);

const reviewers = [
  ['Amit Sharma', 5, 'Excellent ground, well maintained and the floodlights are great for night matches.'],
  ['Priya Verma', 4, 'Good facilities and easy booking. Parking gets a bit crowded on weekends.'],
  ['Vikas Singh', 5, 'Staff is helpful and the surface is top class. Will book again!'],
  ['Neha Gupta', 4, 'Clean washrooms and comfortable seating. Slightly pricey at peak hours.'],
];

// Three sample reviews per ground, rotating through the reviewers.
const reviews = grounds.flatMap((gr, gi) =>
  [0, 1, 2].map((i) => {
    const [name, rating, comment] = reviewers[(gi + i) % reviewers.length];
    return { id: `${gr.id}-r${i}`, groundId: gr.id, name, rating, comment, date: `2026-0${7 + i}-1${i}` };
  }),
);

const coupons = [
  { code: 'FIRST100', description: '₹100 off on bookings above ₹500', type: 'FLAT', value: 100, minAmount: 500 },
  { code: 'PLAY10', description: '10% off, up to ₹200', type: 'PERCENT', value: 10, maxDiscount: 200, minAmount: 0 },
];

// The demo owner already has payout details so online payments work out of
// the box. With PAYMENT_PROVIDER=razorpay the admin still has to link a Route
// account before online payments are accepted.
const users = [
  {
    phone: OWNER_PHONE,
    name: '',
    favorites: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    payout: {
      method: 'UPI',
      accountHolder: 'PlayOn Sports Pvt Ltd',
      upiId: 'playonsports@okaxis',
      contactPhone: OWNER_PHONE,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
];

module.exports = { sports, cities, grounds, reviews, coupons, users, OWNER_PHONE };
