const fs = require('fs');
const seed = require('./seed');

// Tiny persistence layer: an in-memory object, optionally mirrored to a JSON
// file. Swap for a real database in production.
function createStore(file) {
  let data = { sports: seed.sports, spaces: seed.spaces, users: [], bookings: [] };
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
