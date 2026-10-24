const express = require('express');
const { optionalAuth } = require('../auth');
const { getSlots, MAX_ADVANCE_DAYS } = require('../services/slots');
const { todayLocal, isValidDate, addDays } = require('../services/time');
const { distanceKm } = require('../services/geo');
const { ApiError } = require('../errors');
const { canTakeOnline } = require('../services/settlement');

function assertBookableDate(date) {
  if (!isValidDate(date)) throw new ApiError(400, 'INVALID_DATE', 'Date must be YYYY-MM-DD');
  const today = todayLocal();
  if (date < today || date > addDays(today, MAX_ADVANCE_DAYS)) {
    throw new ApiError(400, 'DATE_OUT_OF_RANGE', `Bookings are open from today up to ${MAX_ADVANCE_DAYS} days ahead`);
  }
}

function findGround(store, id) {
  const ground = store.data.grounds.find((g) => g.id === id);
  if (!ground) throw new ApiError(404, 'GROUND_NOT_FOUND', 'Ground not found');
  return ground;
}

// The public shape of a ground, as used in lists and on the details page.
function summarize(store, ground, { phone, lat, lng } = {}) {
  const { slots, ownerPhone, ...rest } = ground;
  const city = store.data.cities.find((c) => c.id === ground.city);
  const user = phone && store.data.users.find((u) => u.phone === phone);
  return {
    ...rest,
    cityName: city?.name,
    state: city?.state,
    pricePerHour: slots.length ? Math.min(...slots.map((s) => s.price)) : null,
    distanceKm: Number.isFinite(lat) && Number.isFinite(lng) ? Math.round(distanceKm(lat, lng, ground.lat, ground.lng) * 10) / 10 : null,
    isFavorite: !!user?.favorites?.includes(ground.id),
    onlinePayments: canTakeOnline(store, ground),
  };
}

function groundRoutes(store) {
  const router = express.Router();
  router.use(optionalAuth);

  router.get('/cities', (_req, res) => res.json(store.data.cities));

  router.get('/sports', (req, res) => {
    const counts = {};
    for (const g of store.data.grounds) {
      if (!req.query.city || g.city === req.query.city) counts[g.sportId] = (counts[g.sportId] || 0) + 1;
    }
    res.json(store.data.sports.map((s) => ({ ...s, groundCount: counts[s.id] || 0 })));
  });

  // Filters: city, sport, type, floodlights=1, favorites=1, q (name/area).
  // With lat & lng, results carry distanceKm and sort=distance is available.
  router.get('/grounds', (req, res) => {
    const { city, sport, type, floodlights, favorites, sort } = req.query;
    const q = String(req.query.q || '').trim().toLowerCase();
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (favorites === '1' && !req.phone) throw new ApiError(401, 'UNAUTHORIZED', 'Login required');

    let list = store.data.grounds
      .filter((g) => !city || g.city === city)
      .filter((g) => !sport || g.sportId === sport)
      .filter((g) => !type || g.type === type)
      .filter((g) => floodlights !== '1' || g.floodlights)
      .filter((g) => !q || `${g.name} ${g.area}`.toLowerCase().includes(q))
      .map((g) => summarize(store, g, { phone: req.phone, lat, lng }))
      .filter((g) => favorites !== '1' || g.isFavorite);

    if (sort === 'distance' && list.every((g) => g.distanceKm !== null)) list.sort((a, b) => a.distanceKm - b.distanceKm);
    else if (sort === 'price') list.sort((a, b) => a.pricePerHour - b.pricePerHour);
    else list.sort((a, b) => b.rating - a.rating);
    res.json(list);
  });

  router.get('/grounds/:id', (req, res) => {
    const ground = findGround(store, req.params.id);
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    res.json({
      ...summarize(store, ground, { phone: req.phone, lat, lng }),
      sport: store.data.sports.find((s) => s.id === ground.sportId),
      reviews: store.data.reviews.filter((r) => r.groundId === ground.id),
    });
  });

  router.get('/grounds/:id/slots', (req, res) => {
    const ground = findGround(store, req.params.id);
    const { date } = req.query;
    assertBookableDate(date);
    const slots = getSlots(store, ground, date)
      .filter((s) => s.status !== 'BLOCKED')
      .map(({ booking, ...s }) => s);
    res.json({ groundId: ground.id, date, slots });
  });

  router.get('/coupons', (_req, res) => res.json(store.data.coupons));

  return router;
}

module.exports = { groundRoutes, assertBookableDate, findGround, summarize };
