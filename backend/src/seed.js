const sports = [
  { id: 'cricket', name: 'Cricket', icon: '🏏' },
  { id: 'football', name: 'Football', icon: '⚽' },
  { id: 'badminton', name: 'Badminton', icon: '🏸' },
  { id: 'tennis', name: 'Tennis', icon: '🎾' },
  { id: 'basketball', name: 'Basketball', icon: '🏀' },
];

// openHour/closeHour are 24h clock; slots are 1 hour long.
const spaces = [
  { id: 'cr-1', sportId: 'cricket', name: 'Turf Arena – Box Cricket', location: 'Sector 21', pricePerSlot: 1200, openHour: 6, closeHour: 23 },
  { id: 'cr-2', sportId: 'cricket', name: 'Green Pitch Nets', location: 'MG Road', pricePerSlot: 600, openHour: 5, closeHour: 21 },
  { id: 'fb-1', sportId: 'football', name: 'Kickoff 5-a-side', location: 'Sector 21', pricePerSlot: 1500, openHour: 6, closeHour: 23 },
  { id: 'fb-2', sportId: 'football', name: 'Goal Zone 7-a-side', location: 'Lake View', pricePerSlot: 2000, openHour: 6, closeHour: 22 },
  { id: 'bd-1', sportId: 'badminton', name: 'Shuttle Hub – Court 1', location: 'City Centre', pricePerSlot: 400, openHour: 6, closeHour: 22 },
  { id: 'bd-2', sportId: 'badminton', name: 'Shuttle Hub – Court 2', location: 'City Centre', pricePerSlot: 400, openHour: 6, closeHour: 22 },
  { id: 'tn-1', sportId: 'tennis', name: 'Ace Tennis Club', location: 'Hill Road', pricePerSlot: 800, openHour: 6, closeHour: 20 },
  { id: 'bb-1', sportId: 'basketball', name: 'Hoops Court', location: 'University Area', pricePerSlot: 700, openHour: 7, closeHour: 22 },
];

module.exports = { sports, spaces };
