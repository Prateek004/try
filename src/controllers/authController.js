'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { getDb } = require('../db/connection');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const DUMMY_HASH    = '$2a$12$eLr2FWz7m3VbmJBbCzKQWOaOEDtB7lGS6cLUvp5Kx3kH1AHdmq0W6';

function getJwtSecret() {
  return process.env.JWT_SECRET || 'change_this_secret_dev_only_32chars!';
}

/** POST /api/v1/auth/login */
function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[AUTH] DB not ready:', err.message);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE email = ? AND is_active = 1'
  ).get(email.toLowerCase().trim());

  // Always run bcrypt to prevent timing attacks
  const hashToCheck = user ? user.password_hash : DUMMY_HASH;
  const valid = bcrypt.compareSync(password, hashToCheck);

  if (!user || !valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { sub: user.id, role: user.role, property: user.property_id },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  return res.json({
    token,
    user: {
      id:          user.id,
      name:        user.name,
      email:       user.email,
      mobile:      user.mobile,
      role:        user.role,
      property_id: user.property_id,
    },
  });
}

/** POST /api/v1/auth/change-password */
function changePassword(req, res) {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both current and new password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(new_password, BCRYPT_ROUNDS), req.user.id);
  return res.json({ message: 'Password updated successfully' });
}

/** GET /api/v1/auth/me */
function me(req, res) {
  const db   = getDb();
  const user = db.prepare(
    'SELECT id, name, email, mobile, role, property_id FROM users WHERE id = ?'
  ).get(req.user.id);
  return res.json(user);
}

module.exports = { login, changePassword, me };
