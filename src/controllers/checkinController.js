'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit, logDocumentAccess } = require('../middleware/auditLog');
const { encrypt, decrypt } = require('../services/encryption');
const { scheduleWhatsApp } = require('../services/whatsappService');

// ── Helpers ────────────────────────────────────────────────
// FIX: removed * 100 — input fields are named _paise, so values arrive in paise already.
// This now matches paymentsController.paise() which also does NOT multiply.
function paise(val) { return Math.round(parseFloat(val || 0)); }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/v1/residents
 * Full check-in: validate → insert resident → create deposit ledger entry →
 * flip bed to occupied → audit → WhatsApp confirmation.
 *
 * FIX: Allows check-in on 'reserved' beds (from confirmed bookings).
 * FIX: Advance payment recorded as type='advance', not 'rent'.
 * FIX: paise() no longer double-converts.
 */
function checkIn(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const {
    full_name, mobile, aadhaar_number, aadhaar_mobile, aadhaar_photo_path,
    aadhaar_consent,
    coming_from, permanent_address, purpose_of_visit,
    emergency_contact_name, emergency_contact_mobile, photo_path,
    bed_id, check_in_date, expected_checkout,
    monthly_rent_paise: rentPaiseRaw, deposit_paise: depositPaiseRaw,
    amount_paid_paise: paidPaiseRaw, payment_mode, gateway_txn_id, notes,
    rent_due_day = 1,
  } = req.body;

  // ── Required fields ───────────────────────────────────────
  const required = { full_name, mobile, bed_id, check_in_date, expected_checkout };
  for (const [f, v] of Object.entries(required)) {
    if (!v) return res.status(400).json({ error: `Field '${f}' is required` });
  }
  if (!aadhaar_consent) {
    return res.status(400).json({ error: 'aadhaar_consent must be true before check-in' });
  }

  const mobileClean = String(mobile).replace(/\D/g, '');
  if (mobileClean.length < 10 || mobileClean.length > 12) {
    return res.status(400).json({ error: 'mobile must be a valid 10–12 digit number' });
  }
  if (!DATE_RE.test(check_in_date)) {
    return res.status(400).json({ error: 'check_in_date must be YYYY-MM-DD' });
  }
  if (!DATE_RE.test(expected_checkout)) {
    return res.status(400).json({ error: 'expected_checkout must be YYYY-MM-DD' });
  }
  if (expected_checkout <= check_in_date) {
    return res.status(400).json({ error: 'expected_checkout must be after check_in_date' });
  }

  // ── Bed availability ──────────────────────────────────────
  const bed = db.prepare('SELECT * FROM beds WHERE id = ? AND property_id = ?').get(bed_id, propertyId);
  if (!bed) return res.status(404).json({ error: 'Bed not found' });

  // FIX: Allow 'reserved' beds (from bookings) in addition to 'available'
  if (bed.status !== 'available' && bed.status !== 'reserved') {
    return res.status(409).json({ error: `Bed is '${bed.status}' — only available or reserved beds can be checked in to` });
  }

  // FIX: If bed has a base_rate and no rent was provided, default to bed rate
  const rentPaise    = (rentPaiseRaw !== undefined && rentPaiseRaw !== null && rentPaiseRaw !== '')
    ? paise(rentPaiseRaw)
    : (bed.base_rate_paise || 0);
  const depositPaise = paise(depositPaiseRaw);
  const paidPaise    = paise(paidPaiseRaw);

  if (rentPaise < 0)    return res.status(400).json({ error: 'monthly_rent_paise must be ≥ 0' });
  if (depositPaise < 0) return res.status(400).json({ error: 'deposit_paise must be ≥ 0' });

  // ── Aadhaar AES-256 encryption ────────────────────────────
  const aadhaarEncrypted = aadhaar_number ? encrypt(String(aadhaar_number)) : null;
  const aadhaarLast4     = aadhaar_number ? String(aadhaar_number).slice(-4) : null;

  const now        = new Date().toISOString();
  const residentId = uuidv4();
  const billingMonth = check_in_date.substring(0, 7);

  // ── Transactional insert ──────────────────────────────────
  db.transaction(() => {
    db.prepare(`
      INSERT INTO residents
        (id, property_id, bed_id, full_name, mobile,
         aadhaar_number_encrypted, aadhaar_last4, aadhaar_mobile, aadhaar_photo_path,
         aadhaar_consent, aadhaar_consent_at,
         coming_from, permanent_address, purpose_of_visit,
         emergency_contact_name, emergency_contact_mobile,
         photo_path, check_in_date, expected_checkout, rent_due_day,
         monthly_rent_paise, deposit_paise, status,
         notes, checkin_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,  'active',?,?,?,?)
    `).run(
      residentId, propertyId, bed_id, full_name, mobileClean,
      aadhaarEncrypted, aadhaarLast4, aadhaar_mobile || null, aadhaar_photo_path || null,
      now,
      coming_from || null, permanent_address || null, purpose_of_visit || null,
      emergency_contact_name || null, emergency_contact_mobile || null,
      photo_path || null, check_in_date, expected_checkout, rent_due_day,
      rentPaise, depositPaise,
      notes || null, req.user.id, now, now
    );

    // Deposit ledger entry
    if (depositPaise > 0) {
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,gateway_txn_id,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','deposit',?,?,?,0,'not_required',?,?,?)
      `).run(
        uuidv4(), propertyId, residentId, billingMonth, depositPaise,
        payment_mode || 'cash', gateway_txn_id || null, now,
        'Deposit on check-in', req.user.id, now
      );
    }

    // FIX: Initial advance payment — recorded as type='advance', not 'rent'.
    // This prevents it from being mistaken for month-1 rent payment in
    // reminders, payment badges, and monthly invoice generation.
    if (paidPaise > 0) {
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,gateway_txn_id,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','advance',?,?,?,0,'not_required',?,?,?)
      `).run(
        uuidv4(), propertyId, residentId, billingMonth, paidPaise,
        payment_mode || 'cash', gateway_txn_id || null, now,
        'Advance payment on check-in', req.user.id, now
      );
    }

    // Flip bed to occupied
    db.prepare(`UPDATE beds SET status='occupied', cleaning_started_at=NULL, booking_request_id=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(bed_id);

    // FIX: If bed was reserved via a booking, link and confirm the booking
    if (bed.status === 'reserved' && bed.booking_request_id) {
      db.prepare(`
        UPDATE booking_requests SET status='confirmed', converted_to_resident_id=?
        WHERE id=? AND status IN ('pending','confirmed')
      `).run(residentId, bed.booking_request_id);
    }
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'CHECKIN',
    entityType: 'resident', entityId: residentId,
    amountPaise: depositPaise + paidPaise,
    snapshot: { resident: full_name, bed_id, check_in_date, rent_paise: rentPaise, deposit_paise: depositPaise },
    ip: req.ip,
  });

  scheduleWhatsApp({
    propertyId, residentId, recipientMobile: mobileClean, recipientType: 'tenant',
    eventType: 'checkin_confirm',
    templateData: { name: full_name, bed: bed_id, checkin: check_in_date, rent: rentPaise / 100 },
  });

  const resident = db.prepare('SELECT * FROM residents WHERE id = ?').get(residentId);
  // Never return encrypted Aadhaar — return masked version
  resident.aadhaar_number_encrypted = undefined;
  resident.aadhaar_display = aadhaarLast4 ? `XXXX XXXX ${aadhaarLast4}` : null;

  return res.status(201).json({ message: 'Check-in successful', resident });
}

/**
 * GET /api/v1/residents
 *
 * FIX: Payment badge now checks CURRENT billing month only (not all-time sum).
 * FIX: Includes type='advance' in paid total alongside 'rent'.
 */
function listResidents(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { status = 'active', search: rawSearch } = req.query;
  const search = rawSearch ? String(rawSearch).trim().substring(0, 100) : null;
  const thisMonth = new Date().toISOString().substring(0, 7);

  let query = `
    SELECT r.id, r.full_name, r.mobile, r.aadhaar_last4,
      r.check_in_date, r.expected_checkout, r.actual_checkout,
      r.monthly_rent_paise, r.deposit_paise, r.status, r.rent_due_day,
      r.created_at, r.checkin_by,
      b.bed_label, b.status as bed_status, b.base_rate_paise,
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
  if (search) {
    query += ' AND (r.full_name LIKE ? OR r.mobile LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  query += ' ORDER BY r.created_at DESC';

  const residents = db.prepare(query).all(...params).map(r => {
    const paid    = r.total_rent_paid_paise || 0;
    const owed    = r.monthly_rent_paise || 0;
    const badge   = paid >= owed ? 'paid' : paid > 0 ? 'partial' : 'pending';
    return {
      ...r,
      payment_badge: badge,
      pending_rent_paise: Math.max(0, owed - paid),
      aadhaar_display: r.aadhaar_last4 ? `XXXX XXXX ${r.aadhaar_last4}` : null,
    };
  });

  return res.json(residents);
}

/**
 * GET /api/v1/residents/:id
 * DPDP: logs Aadhaar access if returning sensitive fields.
 */
function getResident(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const resident = db.prepare(`
    SELECT r.*, b.bed_label, b.base_rate_paise, rm.room_number, f.label as floor_label
    FROM residents r
    LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE r.id = ? AND r.property_id = ?
  `).get(req.params.id, propertyId);

  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  // DPDP: Log Aadhaar number access for owner AND manager roles
  if (resident.aadhaar_number_encrypted && (req.user.role === 'owner' || req.user.role === 'manager')) {
    logDocumentAccess(db, {
      residentId:   resident.id,
      accessedBy:   req.user.id,
      documentType: 'aadhaar_number',
      ip: req.ip,
    });
  }

  // Never return raw encrypted Aadhaar
  resident.aadhaar_number_encrypted = undefined;
  resident.aadhaar_display = resident.aadhaar_last4
    ? `XXXX XXXX ${resident.aadhaar_last4}` : null;

  const payments = db.prepare(
    'SELECT * FROM payment_ledger WHERE resident_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);

  return res.json({ ...resident, payments });
}

/**
 * POST /api/v1/residents/:id/checkout
 * Initiates checkout. If refund > threshold: sets approval_status=pending,
 * does NOT mark resident checked_out yet (waits for approval).
 * If no refund needed: completes checkout immediately.
 */
function checkOut(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { id: residentId } = req.params;

  const {
    checkout_date, extra_charges_paise = 0, extra_charges_note,
    deposit_refund_paise = 0, payment_mode, gateway_txn_id, notes,
  } = req.body;

  if (!checkout_date) return res.status(400).json({ error: 'checkout_date is required' });
  if (!DATE_RE.test(checkout_date)) return res.status(400).json({ error: 'checkout_date must be YYYY-MM-DD' });

  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);

  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  if (resident.status === 'checked_out') {
    return res.status(409).json({ error: 'Resident has already checked out' });
  }

  const now          = new Date().toISOString();
  const refundPaise  = Math.round(parseFloat(deposit_refund_paise) || 0);
  const extraPaise   = Math.round(parseFloat(extra_charges_paise) || 0);

  // Look up approval threshold for this property
  const prop = db.prepare('SELECT refund_approval_threshold_paise FROM properties WHERE id = ?').get(propertyId);
  const threshold = prop?.refund_approval_threshold_paise ?? 0;
  const needsApproval = refundPaise > threshold;

  let refundPaymentId = null;

  db.transaction(() => {
    // Extra charges entry
    if (extraPaise > 0) {
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'credit','extra_charge',?,?,0,'not_required',?,?,?)
      `).run(
        uuidv4(), propertyId, residentId, checkout_date.substring(0,7), extraPaise,
        payment_mode || 'cash', now,
        extra_charges_note || 'Extra charges at checkout', req.user.id, now
      );
    }

    // Refund ledger entry (pending until approved if needed)
    if (refundPaise > 0) {
      refundPaymentId = uuidv4();
      db.prepare(`
        INSERT INTO payment_ledger
          (id,property_id,resident_id,billing_month,amount_paise,direction,type,
           payment_mode,gateway_txn_id,paid_at,requires_approval,approval_status,notes,recorded_by,created_at)
        VALUES (?,?,?,?,?,'debit','deposit_refund',?,?,?,?,?,?,?,?)
      `).run(
        refundPaymentId, propertyId, residentId, checkout_date.substring(0,7), refundPaise,
        payment_mode || 'cash', gateway_txn_id || null, now,
        needsApproval ? 1 : 0,
        needsApproval ? 'pending' : 'not_required',
        notes || 'Deposit refund at checkout',
        req.user.id, now
      );
    }

    if (!needsApproval) {
      // Complete checkout immediately — no approval needed
      db.prepare(`UPDATE residents SET status='checked_out', actual_checkout=?, updated_at=datetime('now') WHERE id=?`)
        .run(checkout_date, residentId);
      if (resident.bed_id) {
        db.prepare(`UPDATE beds SET status='cleaning', cleaning_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
          .run(resident.bed_id);
      }
    }
    // If needsApproval: resident stays 'active', bed stays 'occupied' until owner approves
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'CHECKOUT_INITIATED',
    entityType: 'resident', entityId: residentId,
    amountPaise: refundPaise,
    snapshot: { checkout_date, extra_paise: extraPaise, refund_paise: refundPaise, needs_approval: needsApproval },
    ip: req.ip,
  });

  if (needsApproval) {
    scheduleWhatsApp({
      propertyId, residentId: null,
      recipientMobile: '', // populated via owner lookup in service
      recipientType: 'owner',
      eventType: 'refund_approval_request',
      templateData: {
        resident: resident.full_name,
        amount: refundPaise / 100,
        payment_id: refundPaymentId,
      },
    });
  }

  return res.status(needsApproval ? 202 : 200).json({
    message: needsApproval ? 'Checkout pending refund approval' : 'Checkout complete',
    refund_pending_approval: needsApproval,
    refund_payment_id: refundPaymentId,
  });
}

/**
 * POST /api/v1/residents/:id/checkout/approve
 * Owner/Manager approves or rejects the pending refund.
 * On approval: marks resident checked_out, flips bed to cleaning.
 */
function approveCheckout(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { id: residentId } = req.params;
  const { decision, notes } = req.body;

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  // Find the pending refund payment
  const refundPayment = db.prepare(`
    SELECT * FROM payment_ledger
    WHERE resident_id = ? AND type = 'deposit_refund' AND approval_status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(residentId);

  if (!refundPayment) {
    return res.status(404).json({ error: 'No pending refund found for this resident' });
  }

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      UPDATE payment_ledger SET approval_status=?, approved_by=?, approved_at=?, notes=COALESCE(?,notes)
      WHERE id=?
    `).run(decision, req.user.id, now, notes || null, refundPayment.id);

    if (decision === 'approved') {
      // Now complete the checkout
      db.prepare(`UPDATE residents SET status='checked_out', actual_checkout=datetime('now','localtime'), updated_at=datetime('now') WHERE id=?`)
        .run(residentId);
      if (resident.bed_id) {
        db.prepare(`UPDATE beds SET status='cleaning', cleaning_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
          .run(resident.bed_id);
      }
    }
  })();

  writeAudit({
    propertyId, userId: req.user.id,
    action: decision === 'approved' ? 'CHECKOUT_APPROVED' : 'CHECKOUT_REJECTED',
    entityType: 'resident', entityId: residentId,
    amountPaise: refundPayment.amount_paise,
    snapshot: { decision, approved_by: req.user.name, payment_id: refundPayment.id },
    ip: req.ip,
  });

  return res.json({ message: `Checkout ${decision}`, decision });
}

/**
 * POST /api/v1/residents/:id/extend
 * Extend stay without full re-check-in.
 */
function extendStay(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { id }     = req.params;
  const { new_expected_checkout, new_monthly_rent_paise, notes } = req.body;

  if (!new_expected_checkout) {
    return res.status(400).json({ error: 'new_expected_checkout is required' });
  }

  const resident = db.prepare(
    "SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'"
  ).get(id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Active resident not found' });

  if (new_expected_checkout <= resident.expected_checkout) {
    return res.status(400).json({ error: 'New checkout date must be after current expected checkout' });
  }

  const now     = new Date().toISOString();
  const newRent = new_monthly_rent_paise !== undefined
    ? Math.round(parseFloat(new_monthly_rent_paise))
    : resident.monthly_rent_paise;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO stay_extensions
        (id,resident_id,property_id,old_checkout,new_checkout,old_rent_paise,new_rent_paise,notes,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      uuidv4(), id, propertyId,
      resident.expected_checkout, new_expected_checkout,
      resident.monthly_rent_paise, newRent,
      notes || null, req.user.id, now
    );

    db.prepare(`
      UPDATE residents SET expected_checkout=?, monthly_rent_paise=?, updated_at=datetime('now') WHERE id=?
    `).run(new_expected_checkout, newRent, id);
  })();

  writeAudit({
    propertyId, userId: req.user.id, action: 'STAY_EXTENDED',
    entityType: 'resident', entityId: id,
    snapshot: {
      old_checkout: resident.expected_checkout, new_checkout: new_expected_checkout,
      old_rent_paise: resident.monthly_rent_paise, new_rent_paise: newRent,
    },
    ip: req.ip,
  });

  const updated = db.prepare('SELECT * FROM residents WHERE id = ?').get(id);
  updated.aadhaar_number_encrypted = undefined;
  return res.json({ message: 'Stay extended', resident: updated });
}

/**
 * PATCH /api/v1/residents/:id/rent
 * Owner/Manager changes rent for an active resident without extending checkout.
 */
function updateResidentRent(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { id }     = req.params;
  const { monthly_rent_paise, notes } = req.body;

  if (monthly_rent_paise === undefined || monthly_rent_paise === null) {
    return res.status(400).json({ error: 'monthly_rent_paise is required' });
  }
  const newRent = Math.round(parseFloat(monthly_rent_paise));
  if (newRent < 0) return res.status(400).json({ error: 'monthly_rent_paise must be ≥ 0' });

  const resident = db.prepare(
    "SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'"
  ).get(id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Active resident not found' });

  const oldRent = resident.monthly_rent_paise;
  db.prepare(`UPDATE residents SET monthly_rent_paise=?, updated_at=datetime('now') WHERE id=?`)
    .run(newRent, id);

  writeAudit({
    propertyId, userId: req.user.id, action: 'RENT_UPDATED',
    entityType: 'resident', entityId: id,
    snapshot: { old_rent_paise: oldRent, new_rent_paise: newRent, notes: notes || null },
    ip: req.ip,
  });

  return res.json({ message: 'Rent updated', old_rent_paise: oldRent, new_rent_paise: newRent });
}

module.exports = { checkIn, listResidents, getResident, checkOut, approveCheckout, extendStay, updateResidentRent };
