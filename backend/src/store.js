const fs = require('fs');
const seed = require('./seed');

// Tiny persistence layer: an in-memory object, optionally mirrored to a JSON
// file. Swap for a real database in production.
function createStore(file) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let data = {
    sports: seed.sports,
    cities: seed.cities,
    grounds: clone(seed.grounds), // owners edit slot templates
    reviews: seed.reviews,
    coupons: seed.coupons,
    blockedSlots: [], // { groundId, date, startHour }
    users: [],
    bookings: [],
    notifications: [],
  };
  if (file && fs.existsSync(file)) {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return {
    data,
    save() {
      if (file) fs.writeFileSync(file, JSON.stringify(data, null, 2));
    },
  };
}

module.exports = { createStore };
