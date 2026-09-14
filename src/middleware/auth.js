'use strict';

const jwt    = require('jsonwebtoken');
const { getDb } = require('../db/connection');

// Read secret at call time (not module load time) so Railway env vars are available
function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.startsWith('CHANGE_ME')) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is not configured');
    }
    return 'change_this_secret_dev_only_32chars!';
  }
  return s;
}

const ROLE_WEIGHT = { owner: 3, manager: 2, reception: 1 };

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const db   = getDb();
    const user = db.prepare(
      'SELECT id, property_id, name, role, is_active FROM users WHERE id = ?'
    ).get(payload.sub);

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }
    req.user = { id: user.id, property_id: user.property_id, name: user.name, role: user.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    const userWeight = ROLE_WEIGHT[req.user.role] || 0;
    const minWeight  = ROLE_WEIGHT[minRole]  || 99;
    if (userWeight < minWeight) {
      return res.status(403).json({ error: `Access denied. Requires: ${minRole} or above` });
    }
    next();
  };
}

function sameProperty(req, res, next) {
  const resourcePropertyId =
    req.params.propertyId || req.body?.property_id || req.query?.property_id;
  if (resourcePropertyId && resourcePropertyId !== req.user.property_id) {
    return res.status(403).json({ error: 'Cross-property access denied' });
  }
  req.property_id = req.user.property_id;
  next();
}

function assertOwnsResource(table, paramName = 'id') {
  const ALLOWED = new Set([
    'residents','payment_ledger','beds','users','expenses',
    'audit_log','booking_requests','addon_charges','receipts',
    'refund_deductions','cash_reconciliations','tenant_feedback',
  ]);
  if (!ALLOWED.has(table)) throw new Error(`assertOwnsResource: unknown table '${table}'`);
  return (req, res, next) => {
    const db  = getDb();
    const row = db.prepare(`SELECT property_id FROM ${table} WHERE id = ?`).get(req.params[paramName]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.property_id !== req.user.property_id) return res.status(403).json({ error: 'Access denied' });
    next();
  };
}

function stripFinancial(user, data) {
  if (!user || user.role !== 'reception') return data;
  const HIDDEN = ['total_income','total_expenses','net_profit','today_collection',
    'pending_amount','revenue','expenses','net','monthly_revenue',
    'monthly_expenses','net_income','collection','income'];
  function sanitize(obj) {
    if (Array.isArray(obj)) return obj.map(sanitize);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = HIDDEN.includes(k) ? '[restricted]' : sanitize(v);
      }
      return out;
    }
    return obj;
  }
  return sanitize(data);
}

module.exports = {
  authenticate, requireRole, sameProperty,
  assertOwnsResource, stripFinancial, ROLE_WEIGHT,
};
