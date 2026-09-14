'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit, logDocumentAccess } = require('../middleware/auditLog');
const { encrypt, decrypt } = require('../services/encryption');
const { scheduleWhatsApp } = require('../services/whatsappService');

function paise(val) { return Math.round(parseFloat(val || 0)); }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/v1/residents — Simplified check-in
 *
 * Mandatory: full_name, mobile, bed_id, check_in_date, expected_checkout, aadhaar_consent
 * Rate: auto-fills from bed.daily_rate_paise, staff picks rate_type (daily/weekly/monthly)
 */
function checkIn(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;

  const {
    full_name, mobile, aadhaar_number, aadhaar_mobile, aadhaar_photo_path,
    aadhaar_consent,
    coming_from, purpose_of_visit, permanent_address,
    emergency_contact_name, emergency_contact_mobile, photo_path,
    bed_id, check_in_date, expected_checkout,
    rate_type = 'daily', rate_paise: ratePaiseRaw,
    deposit_paise: depositPaiseRaw,
    amount_paid_paise: paidPaiseRaw, payment_mode, gateway_txn_id, notes,
    rent_due_day = 1,
  } = req.body;

  // Required fields
  const required = { full_name, mobile, bed_id, check_in_date, expected_checkout };
  for (const [f, v] of Object.entries(required)) {
    if (!v) return res.status(400).json({ error: `'${f}' is required` });
  }
  if (!aadhaar_consent) return res.status(400).json({ error: 'Aadhaar consent required' });

  const mobileClean = String(mobile).replace(/\D/g, '');
  if (mobileClean.length < 10 || mobileClean.length > 12) return res.status(400).json({ error: 'Invalid mobile' });
  if (!DATE_RE.test(check_in_date)) return res.status(400).json({ error: 'check_in_date: YYYY-MM-DD' });
  if (!DATE_RE.test(expected_checkout)) return res.status(400).json({ error: 'expected_checkout: YYYY-MM-DD' });
  if (expected_checkout <= check_in_date) return res.status(400).json({ error: 'checkout must be after check-in' });

  const RATE_TYPES = ['daily', 'weekly', 'monthly'];
  if (!RATE_TYPES.includes(rate_type)) return res.status(400).json({ error: `rate_type must be: ${RATE_TYPES.join(', ')}` });

  // Bed check
  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ?').get(bed_id, propertyId);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  if (bed.status !== 'available' && bed.status !== 'reserved') {
    return res.status(409).json({ error: `Bed is '${bed.status}' — only available or reserved beds` });
  }

  // Rate: use provided rate, else derive from bed daily rate
  let ratePaise = paise(ratePaiseRaw);
  if (!ratePaise && bed.daily_rate_paise) {
    if (rate_type === 'daily') ratePaise = bed.daily_rate_paise;
    else if (rate_type === 'weekly') ratePaise = bed.daily_rate_paise * 7;
    else ratePaise = bed.daily_rate_paise * 30;
  }

  // Calculate monthly_rent_paise for backward compat
  let monthlyRent = ratePaise;
  if (rate_type === 'daily') monthlyRent = ratePaise * 30;
  else if (rate_type === 'weekly') monthlyRent = ratePaise * 4;

  const depositPaise = paise(depositPaiseRaw);
  const paidPaise = paise(paidPaiseRaw);

  // Aadhaar
  const aadhaarEncrypted = aadhaar_number ? encrypt(String(aadhaar_number).replace(/\s/g, '')) : null;
  const aadhaarLast4 = aadhaar_number ? String(aadhaar_number).replace(/\s/g, '').slice(-4) : null;

  const now = new Date().toISOString();
  const residentId = uuidv4();
  const billingMonth = check_in_date.substring(0, 7);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO residents
        (id, property_id, bed_id, full_name, mobile,
         aadhaar_number_encrypted, aadhaar_last4, aadhaar_mobile, aadhaar_photo_path,
         aadhaar_consent, aadhaar_consent_at,
         coming_from, permanent_address, purpose_of_visit,
         emergency_contact_name, emergency_contact_mobile,
         photo_path, check_in_date, expected_checkout, rent_due_day,
         monthly_rent_paise, rate_type, rate_paise, deposit_paise, status,
         notes, checkin_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,  'active',?,?,?,?)
    `).run(
      residentId, propertyId, bed_id, full_name.trim(), mobileClean,
      aadhaarEncrypted, aadhaarLast4, aadhaar_mobile || null, aadhaar_photo_path || null,
      now,
      coming_from || null, permanent_address || null, purpose_of_visit || null,
      emergency_contact_name || null, emergency_contact_mobile || null,
      photo_path || null, check_in_date, expected_checkout, rent_due_day,
      monthlyRent, rate_type, ratePaise, depositPaise,
      notes || null, req.user.id, now, now
    );

    if (depositPaise > 0) {
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,gateway_txn_id,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','deposit',?,?,?,0,'not_required',?,?,?)
      `).run(uuidv4(), propertyId, residentId, billingMonth, depositPaise,
        payment_mode || 'cash', gateway_txn_id || null, now, 'Deposit on check-in', req.user.id, now);
    }

    if (paidPaise > 0) {
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,gateway_txn_id,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','advance',?,?,?,0,'not_required',?,?,?)
      `).run(uuidv4(), propertyId, residentId, billingMonth, paidPaise,
        payment_mode || 'cash', gateway_txn_id || null, now, 'Advance on check-in', req.user.id, now);
    }

    db.prepare(`UPDATE beds SET status='occupied', cleaning_started_at=NULL, booking_request_id=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(bed_id);

    if (bed.status === 'reserved' && bed.booking_request_id) {
      db.prepare(`UPDATE booking_requests SET status='confirmed', converted_to_resident_id=? WHERE id=? AND status IN ('pending','confirmed')`)
        .run(residentId, bed.booking_request_id);
    }
  })();

  writeAudit({ propertyId, userId: req.user.id, action: 'CHECKIN',
    entityType: 'resident', entityId: residentId,
    amountPaise: depositPaise + paidPaise,
    snapshot: { resident: full_name, bed_id, check_in_date, rate_type, rate_paise: ratePaise, deposit: depositPaise },
    ip: req.ip });

  scheduleWhatsApp({ propertyId, residentId, recipientMobile: mobileClean, recipientType: 'tenant',
    eventType: 'checkin_confirm',
    templateData: { name: full_name, bed: bed.bed_label, checkin: check_in_date, rate: ratePaise / 100, rate_type } });

  const resident = db.prepare('SELECT * FROM residents WHERE id = ?').get(residentId);
  resident.aadhaar_number_encrypted = undefined;
  resident.aadhaar_display = aadhaarLast4 ? `XXXX XXXX ${aadhaarLast4}` : null;
  return res.status(201).json({ message: 'Check-in successful', resident });
}

/** GET /api/v1/residents */
function listResidents(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { status = 'active', search: rawSearch } = req.query;
  const search = rawSearch ? String(rawSearch).trim().substring(0, 100) : null;
  const thisMonth = new Date().toISOString().substring(0, 7);

  let query = `
    SELECT r.id, r.full_name, r.mobile, r.aadhaar_last4,
      r.check_in_date, r.expected_checkout, r.actual_checkout,
      r.monthly_rent_paise, r.rate_type, r.rate_paise,
      r.deposit_paise, r.status, r.rent_due_day, r.created_at, r.checkin_by,
      b.bed_label, b.status as bed_status, b.daily_rate_paise,
      rm.room_number, f.label as floor_label,
      COALESCE((
        SELECT SUM(l.amount_paise) FROM payment_ledger l
        WHERE l.resident_id = r.id AND l.type IN ('rent','advance') AND l.direction = 'credit'
        AND l.billing_month = ?
      ), 0) as total_rent_paid_paise
    FROM residents r
    LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE r.property_id = ?
  `;
  const params = [thisMonth, propertyId];
  if (status !== 'all') { query += ' AND r.status = ?'; params.push(status); }
  if (search) { query += ' AND (r.full_name LIKE ? OR r.mobile LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  query += ' ORDER BY r.created_at DESC';

  const residents = db.prepare(query).all(...params).map(r => {
    const paid = r.total_rent_paid_paise || 0;
    const owed = r.monthly_rent_paise || 0;
    const badge = paid >= owed ? 'paid' : paid > 0 ? 'partial' : 'pending';
    return { ...r, payment_badge: badge, pending_rent_paise: Math.max(0, owed - paid),
      aadhaar_display: r.aadhaar_last4 ? `XXXX XXXX ${r.aadhaar_last4}` : null };
  });
  return res.json(residents);
}

/** GET /api/v1/residents/:id */
function getResident(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const resident = db.prepare(`
    SELECT r.*, b.bed_label, b.daily_rate_paise as bed_daily_rate, rm.room_number, f.label as floor_label
    FROM residents r LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE r.id = ? AND r.property_id = ?
  `).get(req.params.id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  if (resident.aadhaar_number_encrypted && ['owner','manager'].includes(req.user.role)) {
    logDocumentAccess(db, { residentId: resident.id, accessedBy: req.user.id, documentType: 'aadhaar_number', ip: req.ip });
  }
  resident.aadhaar_number_encrypted = undefined;
  resident.aadhaar_display = resident.aadhaar_last4 ? `XXXX XXXX ${resident.aadhaar_last4}` : null;

  const payments = db.prepare('SELECT * FROM payment_ledger WHERE resident_id = ? ORDER BY created_at DESC').all(req.params.id);
  return res.json({ ...resident, payments });
}

/** POST /api/v1/residents/:id/checkout */
function checkOut(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { id: residentId } = req.params;
  const { checkout_date, extra_charges_paise = 0, extra_charges_note,
    deposit_refund_paise = 0, payment_mode, gateway_txn_id, notes } = req.body;
  if (!checkout_date) return res.status(400).json({ error: 'checkout_date required' });
  if (!DATE_RE.test(checkout_date)) return res.status(400).json({ error: 'checkout_date: YYYY-MM-DD' });

  const resident = db.prepare('SELECT * FROM residents WHERE id = ? AND property_id = ?').get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  if (resident.status === 'checked_out') return res.status(409).json({ error: 'Already checked out' });

  const now = new Date().toISOString();
  const refundPaise = Math.round(parseFloat(deposit_refund_paise) || 0);
  const extraPaise = Math.round(parseFloat(extra_charges_paise) || 0);

  const prop = db.prepare('SELECT refund_approval_threshold_paise FROM properties WHERE id = ?').get(propertyId);
  const threshold = prop?.refund_approval_threshold_paise ?? 0;
  const needsApproval = refundPaise > threshold;
  let refundPaymentId = null;

  db.transaction(() => {
    if (extraPaise > 0) {
      db.prepare(`INSERT INTO payment_ledger (id,property_id,resident_id,billing_month,amount_paise,direction,type,payment_mode,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','extra_charge',?,?,0,'not_required',?,?,?)`)
        .run(uuidv4(), propertyId, residentId, checkout_date.substring(0,7), extraPaise, payment_mode||'cash', now, extra_charges_note||'Extra charges at checkout', req.user.id, now);
    }
    if (refundPaise > 0) {
      refundPaymentId = uuidv4();
      db.prepare(`INSERT INTO payment_ledger (id,property_id,resident_id,billing_month,amount_paise,direction,type,payment_mode,gateway_txn_id,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'debit','deposit_refund',?,?,?,?,?,?,?,?)`)
        .run(refundPaymentId, propertyId, residentId, checkout_date.substring(0,7), refundPaise, payment_mode||'cash', gateway_txn_id||null, now, needsApproval?1:0, needsApproval?'pending':'not_required', notes||'Deposit refund', req.user.id, now);
    }
    if (!needsApproval) {
      db.prepare(`UPDATE residents SET status='checked_out', actual_checkout=?, updated_at=datetime('now') WHERE id=?`).run(checkout_date, residentId);
      if (resident.bed_id) db.prepare(`UPDATE beds SET status='cleaning', cleaning_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(resident.bed_id);
    }
  })();

  writeAudit({ propertyId, userId: req.user.id, action: 'CHECKOUT_INITIATED',
    entityType: 'resident', entityId: residentId, amountPaise: refundPaise,
    snapshot: { checkout_date, extra: extraPaise, refund: refundPaise, needs_approval: needsApproval }, ip: req.ip });

  return res.status(needsApproval ? 202 : 200).json({
    message: needsApproval ? 'Checkout pending refund approval' : 'Checkout complete',
    refund_pending_approval: needsApproval, refund_payment_id: refundPaymentId });
}

/** POST /api/v1/residents/:id/checkout/approve */
function approveCheckout(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { id: residentId } = req.params;
  const { decision, notes } = req.body;
  if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: "decision: 'approved' or 'rejected'" });

  const resident = db.prepare('SELECT * FROM residents WHERE id = ? AND property_id = ?').get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  const refund = db.prepare(`SELECT * FROM payment_ledger WHERE resident_id = ? AND type = 'deposit_refund' AND approval_status = 'pending' ORDER BY created_at DESC LIMIT 1`).get(residentId);
  if (!refund) return res.status(404).json({ error: 'No pending refund' });

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE payment_ledger SET approval_status=?, approved_by=?, approved_at=?, notes=COALESCE(?,notes) WHERE id=?`)
      .run(decision, req.user.id, now, notes||null, refund.id);
    if (decision === 'approved') {
      db.prepare(`UPDATE residents SET status='checked_out', actual_checkout=datetime('now','localtime'), updated_at=datetime('now') WHERE id=?`).run(residentId);
      if (resident.bed_id) db.prepare(`UPDATE beds SET status='cleaning', cleaning_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(resident.bed_id);
    }
  })();
  writeAudit({ propertyId, userId: req.user.id, action: decision==='approved'?'CHECKOUT_APPROVED':'CHECKOUT_REJECTED',
    entityType: 'resident', entityId: residentId, amountPaise: refund.amount_paise, snapshot: { decision }, ip: req.ip });
  return res.json({ message: `Checkout ${decision}`, decision });
}

/** POST /api/v1/residents/:id/extend */
function extendStay(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { id } = req.params;
  const { new_expected_checkout, new_rate_paise, new_rate_type, notes } = req.body;
  if (!new_expected_checkout) return res.status(400).json({ error: 'new_expected_checkout required' });

  const resident = db.prepare("SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'").get(id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Active resident not found' });
  if (new_expected_checkout <= resident.expected_checkout) return res.status(400).json({ error: 'New date must be after current' });

  const now = new Date().toISOString();
  const newRate = new_rate_paise !== undefined ? Math.round(parseFloat(new_rate_paise)) : resident.rate_paise;
  const newType = new_rate_type || resident.rate_type;

  db.transaction(() => {
    db.prepare(`INSERT INTO stay_extensions (id,resident_id,property_id,old_checkout,new_checkout,old_rent_paise,new_rent_paise,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uuidv4(), id, propertyId, resident.expected_checkout, new_expected_checkout, resident.rate_paise, newRate, notes||null, req.user.id, now);
    db.prepare(`UPDATE residents SET expected_checkout=?, rate_paise=?, rate_type=?, monthly_rent_paise=?, updated_at=datetime('now') WHERE id=?`)
      .run(new_expected_checkout, newRate, newType, newType==='daily'?newRate*30:newType==='weekly'?newRate*4:newRate, id);
  })();

  writeAudit({ propertyId, userId: req.user.id, action: 'STAY_EXTENDED', entityType: 'resident', entityId: id,
    snapshot: { old_checkout: resident.expected_checkout, new: new_expected_checkout, old_rate: resident.rate_paise, new_rate: newRate }, ip: req.ip });
  const updated = db.prepare('SELECT * FROM residents WHERE id = ?').get(id);
  updated.aadhaar_number_encrypted = undefined;
  return res.json({ message: 'Stay extended', resident: updated });
}

/** PATCH /api/v1/residents/:id/rent — change rate without extending */
function updateResidentRent(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { id } = req.params;
  const { rate_paise, rate_type, notes } = req.body;
  if (rate_paise === undefined) return res.status(400).json({ error: 'rate_paise required' });

  const resident = db.prepare("SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'").get(id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Active resident not found' });

  const newRate = Math.round(parseFloat(rate_paise));
  const newType = rate_type || resident.rate_type;
  const monthlyRent = newType==='daily'?newRate*30:newType==='weekly'?newRate*4:newRate;

  db.prepare(`UPDATE residents SET rate_paise=?, rate_type=?, monthly_rent_paise=?, updated_at=datetime('now') WHERE id=?`)
    .run(newRate, newType, monthlyRent, id);
  writeAudit({ propertyId, userId: req.user.id, action: 'RENT_UPDATED', entityType: 'resident', entityId: id,
    snapshot: { old_rate: resident.rate_paise, new_rate: newRate, type: newType, notes }, ip: req.ip });
  return res.json({ message: 'Rate updated', old_rate_paise: resident.rate_paise, new_rate_paise: newRate, rate_type: newType });
}

module.exports = { checkIn, listResidents, getResident, checkOut, approveCheckout, extendStay, updateResidentRent };
