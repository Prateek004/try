'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }       = require('../db/connection');
const { writeAudit }  = require('../middleware/auditLog');

// Ensure new columns exist — runs once, idempotent
let _migrated = false;
function ensureBedColumns(db) {
  if (_migrated) return;
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('beds')").all().map(c => c.name);
    if (!cols.includes('daily_rate_paise')) db.exec("ALTER TABLE beds ADD COLUMN daily_rate_paise INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes('base_rate_paise')) db.exec("ALTER TABLE beds ADD COLUMN base_rate_paise INTEGER NOT NULL DEFAULT 0");
  } catch(e) { console.warn('[MIGRATION] Bed columns:', e.message); }
  _migrated = true;
}

/** GET /api/v1/beds — flat list with resident + hierarchy info */
function listBeds(req, res) {
  const db = getDb();
  ensureBedColumns(db);
  const { status, floor_id, room_id } = req.query;
  let q = `
    SELECT b.*, r.full_name as resident_name, r.id as resident_id,
           r.monthly_rent_paise, r.rate_paise, r.rate_type,
           r.deposit_paise, r.expected_checkout, r.check_in_date,
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

/** GET /api/v1/beds/:id — single bed with resident detail */
function getBed(req, res) {
  const db = getDb();
  const bed = db.prepare(`
    SELECT b.*, rm.room_number, rm.room_type, f.label as floor_label, f.floor_number,
           r.id as resident_id, r.full_name as resident_name, r.mobile as resident_mobile,
           r.monthly_rent_paise, r.rate_paise, r.rate_type, r.deposit_paise,
           r.check_in_date, r.expected_checkout
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
  if (bed.status === 'occupied' && status !== 'occupied') {
    const hasActive = db.prepare(
      "SELECT COUNT(*) as c FROM residents WHERE bed_id = ? AND status = 'active'"
    ).get(req.params.id);
    if (hasActive.c > 0) {
      return res.status(409).json({ error: 'Cannot change occupied bed with active resident. Use checkout.' });
    }
  }
  const cleaningAt = status === 'cleaning' ? "datetime('now')" : 'NULL';
  db.prepare(`UPDATE beds SET status=?, cleaning_started_at=${cleaningAt}, updated_at=datetime('now') WHERE id=?`)
    .run(status, req.params.id);
  writeAudit({ propertyId: req.user.property_id, userId: req.user.id,
    action: 'BED_STATUS_UPDATE', entityType: 'beds', entityId: req.params.id,
    snapshot: { from: bed.status, to: status, notes }, ip: req.ip });
  return res.json(db.prepare('SELECT * FROM beds WHERE id = ?').get(req.params.id));
}

/** PATCH /api/v1/beds/:id/rate — owner sets price for ONE bed */
function updateBedRate(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { daily_rate_paise } = req.body;
  if (daily_rate_paise === undefined || daily_rate_paise === null) {
    return res.status(400).json({ error: 'daily_rate_paise is required' });
  }
  const rate = Math.round(parseFloat(daily_rate_paise));
  if (rate < 0) return res.status(400).json({ error: 'daily_rate_paise must be ≥ 0' });
  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ?')
    .get(req.params.id, propertyId);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });

  db.prepare(`UPDATE beds SET daily_rate_paise=?, base_rate_paise=?, updated_at=datetime('now') WHERE id=?`)
    .run(rate, rate, req.params.id);
  writeAudit({ propertyId, userId: req.user.id,
    action: 'BED_RATE_UPDATE', entityType: 'beds', entityId: req.params.id,
    amountPaise: rate, snapshot: { old: bed.daily_rate_paise, new: rate }, ip: req.ip });
  return res.json(db.prepare('SELECT * FROM beds WHERE id = ?').get(req.params.id));
}

/** PATCH /api/v1/beds/bulk-rate — owner sets rate for multiple beds at once */
function bulkUpdateBedRate(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { bed_ids, daily_rate_paise } = req.body;
  if (!Array.isArray(bed_ids) || bed_ids.length === 0) {
    return res.status(400).json({ error: 'bed_ids must be a non-empty array' });
  }
  const rate = Math.round(parseFloat(daily_rate_paise));
  if (rate < 0) return res.status(400).json({ error: 'daily_rate_paise must be ≥ 0' });

  const placeholders = bed_ids.map(() => '?').join(',');
  const beds = db.prepare(
    `SELECT id FROM beds WHERE id IN (${placeholders}) AND property_id = ?`
  ).all(...bed_ids, propertyId);
  if (beds.length === 0) return res.status(404).json({ error: 'No matching beds found' });

  db.transaction(() => {
    beds.forEach(b => {
      db.prepare(`UPDATE beds SET daily_rate_paise=?, base_rate_paise=?, updated_at=datetime('now') WHERE id=?`)
        .run(rate, rate, b.id);
    });
  })();
  writeAudit({ propertyId, userId: req.user.id,
    action: 'BED_RATE_BULK_UPDATE', entityType: 'beds', entityId: beds.map(b=>b.id).join(','),
    amountPaise: rate, snapshot: { count: beds.length, rate }, ip: req.ip });
  return res.json({ message: `Rate updated for ${beds.length} bed(s)`, updated: beds.length, daily_rate_paise: rate });
}

/** POST /api/v1/beds */
function createBed(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { room_id, bed_label, daily_rate_paise = 0 } = req.body;
  if (!room_id || !bed_label) return res.status(400).json({ error: 'room_id and bed_label are required' });
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND property_id = ?').get(room_id, propertyId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const rate = Math.round(parseFloat(daily_rate_paise) || 0);
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO beds (id, room_id, property_id, bed_label, daily_rate_paise, base_rate_paise, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)
  `).run(id, room_id, propertyId, bed_label.trim(), rate, rate, now, now);
  return res.status(201).json(db.prepare('SELECT * FROM beds WHERE id = ?').get(id));
}

/** GET /api/v1/floors — hierarchy: floors → rooms → bed count */
function listFloors(req, res) {
  const db = getDb();
  const floors = db.prepare('SELECT * FROM floors WHERE property_id = ? ORDER BY floor_number').all(req.user.property_id);
  const rooms  = db.prepare('SELECT * FROM rooms WHERE property_id = ? ORDER BY room_number').all(req.user.property_id);
  const beds   = db.prepare(`
    SELECT b.id, b.room_id, b.bed_label, b.status, b.daily_rate_paise,
           r.full_name as resident_name, r.id as resident_id
    FROM beds b LEFT JOIN residents r ON r.bed_id = b.id AND r.status = 'active'
    WHERE b.property_id = ?
  `).all(req.user.property_id);

  const result = floors.map(f => ({
    ...f,
    rooms: rooms.filter(rm => rm.floor_id === f.id).map(rm => ({
      ...rm,
      beds: beds.filter(b => b.room_id === rm.id),
      total_beds: beds.filter(b => b.room_id === rm.id).length,
      occupied: beds.filter(b => b.room_id === rm.id && b.status === 'occupied').length,
    })),
  }));
  return res.json(result);
}

/** POST /api/v1/floors */
function addFloor(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { floor_number, label } = req.body;
  if (!floor_number || !label) return res.status(400).json({ error: 'floor_number and label are required' });

  const existing = db.prepare('SELECT id FROM floors WHERE property_id = ? AND floor_number = ?').get(propertyId, floor_number);
  if (existing) return res.status(409).json({ error: `Floor ${floor_number} already exists` });

  const id = uuidv4();
  db.prepare('INSERT INTO floors (id, property_id, floor_number, label, created_at) VALUES (?,?,?,?,datetime("now"))')
    .run(id, propertyId, floor_number, label.trim());
  writeAudit({ propertyId, userId: req.user.id, action: 'FLOOR_CREATED',
    entityType: 'floors', entityId: id, snapshot: { floor_number, label }, ip: req.ip });
  return res.status(201).json(db.prepare('SELECT * FROM floors WHERE id = ?').get(id));
}

/** POST /api/v1/rooms */
function addRoom(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { floor_id, room_number, room_type = 'shared' } = req.body;
  if (!floor_id || !room_number) return res.status(400).json({ error: 'floor_id and room_number are required' });

  const floor = db.prepare('SELECT * FROM floors WHERE id = ? AND property_id = ?').get(floor_id, propertyId);
  if (!floor) return res.status(404).json({ error: 'Floor not found' });

  const TYPES = ['shared', 'private', 'dormitory'];
  if (!TYPES.includes(room_type)) return res.status(400).json({ error: `room_type must be: ${TYPES.join(', ')}` });

  const existing = db.prepare('SELECT id FROM rooms WHERE property_id = ? AND room_number = ?').get(propertyId, room_number);
  if (existing) return res.status(409).json({ error: `Room ${room_number} already exists` });

  const id = uuidv4();
  db.prepare('INSERT INTO rooms (id, floor_id, property_id, room_number, room_type, created_at) VALUES (?,?,?,?,?,datetime("now"))')
    .run(id, floor_id, propertyId, room_number.trim(), room_type);
  writeAudit({ propertyId, userId: req.user.id, action: 'ROOM_CREATED',
    entityType: 'rooms', entityId: id, snapshot: { floor_id, room_number, room_type }, ip: req.ip });
  return res.status(201).json(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id));
}

module.exports = { listBeds, getBed, updateBedStatus, updateBedRate, bulkUpdateBedRate, createBed, listFloors, addFloor, addRoom };
