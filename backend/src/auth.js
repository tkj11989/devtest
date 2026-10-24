const jwt = require('jsonwebtoken');
const config = require('./config');
const { ApiError } = require('./errors');

const signToken = (phone) => jwt.sign({ sub: phone }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

function readToken(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    return jwt.verify(token, config.jwtSecret).sub;
  } catch {
    return undefined;
  }
}

function requireAuth(req, _res, next) {
  const phone = readToken(req);
  if (phone === null) return next(new ApiError(401, 'UNAUTHORIZED', 'Login required'));
  if (phone === undefined) return next(new ApiError(401, 'UNAUTHORIZED', 'Session expired, please login again'));
  req.phone = phone;
  next();
}

// Sets req.phone when a valid token is present; never rejects.
function optionalAuth(req, _res, next) {
  req.phone = readToken(req) || null;
  next();
}

module.exports = { signToken, requireAuth, optionalAuth };
