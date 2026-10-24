const express = require('express');
const { getSlots, MAX_ADVANCE_DAYS } = require('../services/slots');
const { todayLocal, isValidDate, addDays } = require('../services/time');
const { ApiError } = require('../errors');

module.exports = function catalogRoutes(store) {
  const router = express.Router();

  router.get('/sports', (_req, res) => {
    const counts = {};
    for (const s of store.data.spaces) counts[s.sportId] = (counts[s.sportId] || 0) + 1;
    res.json(store.data.sports.map((s) => ({ ...s, spaceCount: counts[s.id] || 0 })));
  });

  router.get('/sports/:sportId/spaces', (req, res) => {
    if (!store.data.sports.some((s) => s.id === req.params.sportId)) {
      throw new ApiError(404, 'SPORT_NOT_FOUND', 'Sport not found');
    }
    res.json(store.data.spaces.filter((s) => s.sportId === req.params.sportId));
  });

  router.get('/spaces/:spaceId/slots', (req, res) => {
    const space = store.data.spaces.find((s) => s.id === req.params.spaceId);
    if (!space) throw new ApiError(404, 'SPACE_NOT_FOUND', 'Space not found');
    const { date } = req.query;
    assertBookableDate(date);
    res.json({ space, date, slots: getSlots(store, space, date) });
  });

  return router;
};

function assertBookableDate(date) {
  if (!isValidDate(date)) throw new ApiError(400, 'INVALID_DATE', 'Date must be YYYY-MM-DD');
  const today = todayLocal();
  if (date < today || date > addDays(today, MAX_ADVANCE_DAYS)) {
    throw new ApiError(400, 'DATE_OUT_OF_RANGE', `Bookings are open from today up to ${MAX_ADVANCE_DAYS} days ahead`);
  }
}

module.exports.assertBookableDate = assertBookableDate;
