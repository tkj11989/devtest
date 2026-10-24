const jwt = require('jsonwebtoken');
const config = require('./config');
const { ApiError } = require('./errors');

const signToken = (phone) => jwt.sign({ sub: phone }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

function requireAuth(req, _res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(new ApiError(401, 'UNAUTHORIZED', 'Login required'));
  try {
    req.phone = jwt.verify(token, config.jwtSecret).sub;
    next();
  } catch {
    next(new ApiError(401, 'UNAUTHORIZED', 'Session expired, please login again'));
  }
}

module.exports = { signToken, requireAuth };
