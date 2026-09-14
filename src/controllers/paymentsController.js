'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const { scheduleWhatsApp } = require('../services/whatsappService');
const { generateReceipt } = require('../services/receiptService');

function paise(v) { return Math.round(parseFloat(v || 0)); }

/**
 * POST /api/v1/payments
 * Record a rent/advance/extra_charge payment.
 */
function recordPayment(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;

  const {
    resident_id, amount_paise, type = 'rent', payment_mode = 'cash',
    billing_month, gateway_txn_id, due_date, notes,
  } = req.body;

  if (!resident_id) return res.status(400).json({ error: 'resident_id is required' });
  const amtPaise = paise(amount_paise);
  if (!amtPaise || amtPaise <= 0) return res.status(400).json({ error: 'amount_paise must be > 0' });

  const VALID_TYPES = ['rent', 'advance', 'extra_charge', 'deposit'];
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  const resident = db.prepare(
    "SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = 'active'"
  ).get(resident_id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Active resident not found' });

  const now = new Date().toISOString();
  const paymentId = uuidv4();

  db.prepare(`
    INSERT INTO payment_ledger
      (id,property_id,resident_id,billing_month,amount_paise,direction,type,
       payment_mode,gateway_txn_id,due_date,paid_at,requires_approval,
       approval_status,notes,recorded_by,created_at)
    VALUES (?,?,?,?,?,'credit',?,?,?,?,?,0,'not_required',?,?,?)
  `).run(
    paymentId, propertyId, resident_id,
    billing_month || now.substring(0, 7),
    amtPaise, type, payment_mode, gateway_txn_id || null,
    due_date || null, now, notes || null, req.user.id, now
  );

  writeAudit({
    propertyId, userId: req.user.id, action: 'PAYMENT_RECORDED',
    entityType: 'payment_ledger', entityId: paymentId,
    amountPaise: amtPaise,
    snapshot: { resident_id, type, mode: payment_mode, billing_month },
    ip: req.ip,
  });

  // Generate receipt async
  generateReceipt({ db, paymentId, propertyId, residentId: resident_id, actorId: req.user.id })
    .then(receipt => {
      if (receipt && resident.mobile) {
        scheduleWhatsApp({
          propertyId, residentId: resident_id,
          recipientMobile: resident.mobile, recipientType: 'tenant',
          eventType: 'payment_receipt',
          templateData: {
            name: resident.full_name,
            amount: amtPaise / 100,
            receipt_no: receipt.receipt_number,
            month: billing_month || now.substring(0, 7),
          },
        });
      }
    })
    .catch(err => console.error('[RECEIPT]', err.message));

  const payment = db.prepare('SELECT * FROM payment_ledger WHERE id = ?').get(paymentId);
  return res.status(201).json({ message: 'Payment recorded', payment });
}

/**
 * GET /api/v1/residents/:id/ledger
 */
function getResidentLedger(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const residentId = req.params.id;

  const resident = db.prepare(
    'SELECT id, full_name, mobile, monthly_rent_paise, deposit_paise, status FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  const ledger = db.prepare(
    'SELECT * FROM payment_ledger WHERE resident_id = ? ORDER BY created_at DESC'
  ).all(residentId);

  const totalPaid      = ledger.filter(l => l.direction === 'credit').reduce((s, l) => s + l.amount_paise, 0);
  const totalRefunded  = ledger.filter(l => l.direction === 'debit').reduce((s, l) => s + l.amount_paise, 0);
  const balance        = totalPaid - totalRefunded;
  const pendingApproval= ledger.filter(l => l.approval_status === 'pending');

  return res.json({
    resident,
    ledger,
    summary: {
      total_paid_paise:     totalPaid,
      total_refunded_paise: totalRefunded,
      balance_paise:        balance,
      pending_approval:     pendingApproval.length,
    },
  });
}

/**
 * GET /api/v1/payments/pending-approvals
 */
function pendingApprovals(req, res) {
  const db = getDb();
  const list = db.prepare(`
    SELECT pl.*, r.full_name as resident_name, r.mobile as resident_mobile
    FROM payment_ledger pl
    JOIN residents r ON r.id = pl.resident_id
    WHERE pl.property_id = ? AND pl.approval_status = 'pending'
    ORDER BY pl.created_at ASC
  `).all(req.user.property_id);
  return res.json(list);
}

/**
 * POST /api/v1/payments/:id/approve
 */
function approvePayment(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { decision, notes } = req.body;

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  const payment = db.prepare(
    "SELECT * FROM payment_ledger WHERE id = ? AND property_id = ? AND approval_status = 'pending'"
  ).get(req.params.id, propertyId);
  if (!payment) return res.status(404).json({ error: 'Pending payment not found' });

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE payment_ledger
    SET approval_status=?, approved_by=?, approved_at=?, notes=COALESCE(?,notes)
    WHERE id=?
  `).run(decision, req.user.id, now, notes || null, req.params.id);

  writeAudit({
    propertyId, userId: req.user.id,
    action: `PAYMENT_${decision.toUpperCase()}`,
    entityType: 'payment_ledger', entityId: req.params.id,
    amountPaise: payment.amount_paise,
    snapshot: { decision, type: payment.type },
    ip: req.ip,
  });

  return res.json({ message: `Payment ${decision}`, decision });
}

/**
 * POST /api/v1/residents/:id/refund-deductions
 */
function addRefundDeduction(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const residentId = req.params.id;
  const { amount_paise, reason } = req.body;

  const amtPaise = paise(amount_paise);
  if (!amtPaise || amtPaise <= 0) return res.status(400).json({ error: 'amount_paise must be > 0' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason is required' });

  const resident = db.prepare(
    'SELECT id FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO refund_deductions (id, resident_id, amount_paise, reason, logged_by, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, residentId, amtPaise, reason.trim(), req.user.id);

  return res.status(201).json({ id, resident_id: residentId, amount_paise: amtPaise, reason: reason.trim() });
}

/**
 * GET /api/v1/residents/:id/refund-summary
 */
function getRefundSummary(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const residentId = req.params.id;

  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  const deductions = db.prepare(
    'SELECT * FROM refund_deductions WHERE resident_id = ?'
  ).all(residentId);

  const extraCharges = db.prepare(
    "SELECT COALESCE(SUM(amount_paise),0) as total FROM payment_ledger WHERE resident_id = ? AND type = 'extra_charge' AND direction = 'credit'"
  ).get(residentId);

  const pendingRent = db.prepare(`
    SELECT COALESCE(SUM(pl.amount_paise),0) as total FROM payment_ledger pl
    WHERE pl.resident_id = ? AND pl.type = 'rent' AND pl.approval_status != 'rejected'
    AND pl.direction = 'credit'
  `).get(residentId);

  const depositPaid = resident.deposit_paise;
  const totalDeductions = deductions.reduce((s, d) => s + d.amount_paise, 0)
    + (extraCharges.total || 0);

  const dues = Math.max(0, (resident.monthly_rent_paise || 0) - (pendingRent.total || 0));
  const netRefund = Math.max(0, depositPaid - totalDeductions - dues);
  const isBlocked = (depositPaid - totalDeductions - dues) < 0;

  return res.json({
    deposit_paise:      depositPaid,
    total_deductions_paise: totalDeductions,
    pending_dues_paise: dues,
    net_refund_paise:   netRefund,
    is_blocked:         isBlocked,
    block_reason:       isBlocked ? 'Dues exceed deposit amount — resident must clear balance before checkout' : null,
    deductions,
  });
}

module.exports = {
  recordPayment, getResidentLedger, pendingApprovals,
  approvePayment, addRefundDeduction, getRefundSummary,
};
