const express = require('express');
const { requireAuth } = require('../auth');
const { findGround } = require('./grounds');
const { ApiError } = require('../errors');
const config = require('../config');

const publicUser = (store, u) => ({
  phone: u.phone,
  name: u.name || '',
  favorites: u.favorites || [],
  isOwner: store.data.grounds.some((g) => g.ownerPhone === u.phone),
  isAdmin: u.phone === config.adminPhone,
  createdAt: u.createdAt,
});

function meRoutes(store) {
  const router = express.Router();
  const currentUser = (req) => {
    const user = store.data.users.find((u) => u.phone === req.phone);
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Please login again');
    return user;
  };

  router.get('/me', requireAuth, (req, res) => res.json(publicUser(store, currentUser(req))));

  router.patch('/me', requireAuth, (req, res) => {
    const user = currentUser(req);
    const name = String(req.body.name ?? '').trim();
    if (name.length < 2 || name.length > 60) throw new ApiError(400, 'INVALID_NAME', 'Please enter your name');
    user.name = name;
    store.save();
    res.json(publicUser(store, user));
  });

  router.put('/me/favorites/:groundId', requireAuth, (req, res) => {
    const user = currentUser(req);
    findGround(store, req.params.groundId);
    const favs = new Set(user.favorites || []);
    if (req.body.favorite === false) favs.delete(req.params.groundId);
    else favs.add(req.params.groundId);
    user.favorites = [...favs];
    store.save();
    res.json(publicUser(store, user));
  });

  router.get('/notifications', requireAuth, (req, res) => {
    res.json(
      store.data.notifications
        .filter((n) => n.phone === req.phone)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  });

  router.post('/notifications/read', requireAuth, (req, res) => {
    for (const n of store.data.notifications) if (n.phone === req.phone) n.read = true;
    store.save();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { meRoutes, publicUser };
