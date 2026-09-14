'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }       = require('../db/connection');
const { writeAudit }  = require('../middleware/auditLog');

/** GET /api/v1/beds */
function listBeds(req, res) {
  const db = getDb();
  const { status, floor_id, room_id } = req.query;
  let q = `
    SELECT b.*, r.full_name as resident_name, r.id as resident_id,
           r.monthly_rent_paise, r.expected_checkout,
           rm.room_number, rm.room_type, f.label as floor_label, f.floor_number
    FROM beds b
    LEFT JOIN residents r ON r.bed_id = b.id AND r.status = 'active'
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE b.property_id = ?
  `;
  const params = [req.user.property_id];
  if (status)   { q += ' AND b.status = ?'; params.push(status); }
  if (floor_id) { q += ' AND rm.floor_id = ?'; params.push(floor_id); }
  if (room_id)  { q += ' AND b.room_id = ?'; params.push(room_id); }
  q += ' ORDER BY f.floor_number, rm.room_number, b.bed_label';
  return res.json(db.prepare(q).all(...params));
}

/** GET /api/v1/beds/:id */
function getBed(req, res) {
  const db = getDb();
  const bed = db.prepare(`
    SELECT b.*, rm.room_number, f.label as floor_label,
           r.id as resident_id, r.full_name as resident_name, r.mobile as resident_mobile,
           r.monthly_rent_paise, r.deposit_paise, r.check_in_date, r.expected_checkout
    FROM beds b
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    LEFT JOIN residents r ON r.bed_id = b.id AND r.status = 'active'
    WHERE b.id = ? AND b.property_id = ?
  `).get(req.params.id, req.user.property_id);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  return res.json(bed);
}

/** PATCH /api/v1/beds/:id/status */
function updateBedStatus(req, res) {
  const db = getDb();
  const { status, notes } = req.body;
  const VALID = ['available', 'cleaning', 'occupied', 'reserved', 'pending'];
  if (!VALID.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
  }

  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ?')
    .get(req.params.id, req.user.property_id);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });

  // Safety: don't allow manual clearing of occupied beds
  if (bed.status === 'occupied' && status !== 'occupied') {
    const hasActive = db.prepare(
      "SELECT COUNT(*) as c FROM residents WHERE bed_id = ? AND status = 'active'"
    ).get(req.params.id);
    if (hasActive.c > 0) {
      return res.status(409).json({ error: 'Cannot change status of occupied bed with active resident. Use checkout flow.' });
    }
  }

  const cleaningAt = status === 'cleaning' ? "datetime('now')" : 'NULL';
  db.prepare(`UPDATE beds SET status=?, cleaning_started_at=${cleaningAt}, updated_at=datetime('now') WHERE id=?`)
    .run(status, req.params.id);

  writeAudit({
    propertyId: req.user.property_id, userId: req.user.id,
    action: 'BED_STATUS_UPDATE', entityType: 'beds', entityId: req.params.id,
    snapshot: { from: bed.status, to: status, notes },
    ip: req.ip,
  });

  return res.json(db.prepare('SELECT * FROM beds WHERE id = ?').get(req.params.id));
}

/**
 * PATCH /api/v1/beds/:id/rate
 * Owner/Manager sets the base rate for a bed.
 * This becomes the default monthly_rent_paise for new check-ins on this bed.
 */
function updateBedRate(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { base_rate_paise } = req.body;

  if (base_rate_paise === undefined || base_rate_paise === null) {
    return res.status(400).json({ error: 'base_rate_paise is required' });
  }
  const ratePaise = Math.round(parseFloat(base_rate_paise));
  if (ratePaise < 0) return res.status(400).json({ error: 'base_rate_paise must be ≥ 0' });

  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ?')
    .get(req.params.id, propertyId);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });

  const oldRate = bed.base_rate_paise || 0;
  db.prepare(`UPDATE beds SET base_rate_paise=?, updated_at=datetime('now') WHERE id=?`)
    .run(ratePaise, req.params.id);

  writeAudit({
    propertyId, userId: req.user.id,
    action: 'BED_RATE_UPDATE', entityType: 'beds', entityId: req.params.id,
    amountPaise: ratePaise,
    snapshot: { old_rate_paise: oldRate, new_rate_paise: ratePaise },
    ip: req.ip,
  });

  return res.json(db.prepare('SELECT * FROM beds WHERE id = ?').get(req.params.id));
}

/**
 * PATCH /api/v1/beds/bulk-rate
 * Owner sets rate for multiple beds at once.
 */
function bulkUpdateBedRate(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { bed_ids, base_rate_paise } = req.body;

  if (!Array.isArray(bed_ids) || bed_ids.length === 0) {
    return res.status(400).json({ error: 'bed_ids must be a non-empty array' });
  }
  if (base_rate_paise === undefined || base_rate_paise === null) {
    return res.status(400).json({ error: 'base_rate_paise is required' });
  }
  const ratePaise = Math.round(parseFloat(base_rate_paise));
  if (ratePaise < 0) return res.status(400).json({ error: 'base_rate_paise must be ≥ 0' });

  const placeholders = bed_ids.map(() => '?').join(',');
  const beds = db.prepare(
    `SELECT id FROM beds WHERE id IN (${placeholders}) AND property_id = ?`
  ).all(...bed_ids, propertyId);

  if (beds.length === 0) return res.status(404).json({ error: 'No matching beds found' });

  db.transaction(() => {
    beds.forEach(b => {
      db.prepare(`UPDATE beds SET base_rate_paise=?, updated_at=datetime('now') WHERE id=?`)
        .run(ratePaise, b.id);
    });
  })();

  writeAudit({
    propertyId, userId: req.user.id,
    action: 'BED_RATE_BULK_UPDATE', entityType: 'beds', entityId: beds.map(b => b.id).join(','),
    amountPaise: ratePaise,
    snapshot: { bed_count: beds.length, new_rate_paise: ratePaise },
    ip: req.ip,
  });

  return res.json({ message: `Rate updated for ${beds.length} bed(s)`, updated: beds.length, base_rate_paise: ratePaise });
}

/** POST /api/v1/beds */
function createBed(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { room_id, bed_label, base_rate_paise = 0 } = req.body;
  if (!room_id || !bed_label) {
    return res.status(400).json({ error: 'room_id and bed_label are required' });
  }
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND property_id = ?').get(room_id, propertyId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const ratePaise = Math.round(parseFloat(base_rate_paise) || 0);
  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO beds (id, room_id, property_id, bed_label, base_rate_paise, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'available', ?, ?)
  `).run(id, room_id, propertyId, bed_label.trim(), ratePaise, now, now);

  return res.status(201).json(db.prepare('SELECT * FROM beds WHERE id = ?').get(id));
}

/** GET /api/v1/floors – list floors and rooms */
function listFloors(req, res) {
  const db = getDb();
  const floors = db.prepare('SELECT * FROM floors WHERE property_id = ? ORDER BY floor_number').all(req.user.property_id);
  const rooms  = db.prepare('SELECT * FROM rooms WHERE property_id = ? ORDER BY room_number').all(req.user.property_id);
  const result = floors.map(f => ({
    ...f,
    rooms: rooms.filter(r => r.floor_id === f.id),
  }));
  return res.json(result);
}

module.exports = { listBeds, getBed, updateBedStatus, updateBedRate, bulkUpdateBedRate, createBed, listFloors };
