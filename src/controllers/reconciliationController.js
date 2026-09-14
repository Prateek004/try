'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }       = require('../db/connection');
const { writeAudit }  = require('../middleware/auditLog');
const { scheduleWhatsApp } = require('../services/whatsappService');

/**
 * POST /api/v1/reconciliation/cash
 *
 * FIX: System total now = cash credits − cash debits (refunds).
 * Previously only counted credits, so any cash refund created a phantom discrepancy.
 */
function closeCashDrawer(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { date, drawer_amount_paise } = req.body;

  if (!date || drawer_amount_paise === undefined) {
    return res.status(400).json({ error: 'date and drawer_amount_paise are required' });
  }
  const drawerPaise = Math.round(parseFloat(drawer_amount_paise));

  // FIX: Cash IN (credits) for the day
  const cashIn = db.prepare(`
    SELECT COALESCE(SUM(amount_paise), 0) as total FROM payment_ledger
    WHERE property_id = ? AND payment_mode = 'cash' AND direction = 'credit'
    AND date(paid_at) = ?
  `).get(propertyId, date);

  // FIX: Cash OUT (refunds paid in cash) for the day
  const cashOut = db.prepare(`
    SELECT COALESCE(SUM(amount_paise), 0) as total FROM payment_ledger
    WHERE property_id = ? AND payment_mode = 'cash' AND direction = 'debit'
    AND date(paid_at) = ? AND approval_status != 'rejected'
  `).get(propertyId, date);

  const systemPaise = cashIn.total - cashOut.total;
  const deltaPaise  = drawerPaise - systemPaise;

  const prop = db.prepare('SELECT cash_reconciliation_tolerance_paise FROM properties WHERE id = ?').get(propertyId);
  const tolerance = prop?.cash_reconciliation_tolerance_paise ?? 0;
  const isDiscrepancy = Math.abs(deltaPaise) > tolerance;

  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cash_reconciliations
      (id, property_id, date, drawer_amount_paise, system_amount_paise, delta_paise,
       is_discrepancy, submitted_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, propertyId, date, drawerPaise, systemPaise, deltaPaise,
    isDiscrepancy ? 1 : 0, req.user.id, now);

  writeAudit({
    propertyId, userId: req.user.id, action: 'CASH_RECONCILIATION',
    entityType: 'cash_reconciliations', entityId: id,
    amountPaise: deltaPaise,
    snapshot: { date, drawer: drawerPaise, system: systemPaise, cash_in: cashIn.total, cash_out: cashOut.total, delta: deltaPaise, is_discrepancy: isDiscrepancy },
    ip: req.ip,
  });

  if (isDiscrepancy) {
    scheduleWhatsApp({
      propertyId, residentId: null,
      recipientMobile: '', recipientType: 'owner',
      eventType: 'cash_discrepancy_alert',
      templateData: {
        date, delta: (deltaPaise / 100).toFixed(2),
        drawer: (drawerPaise / 100).toFixed(2),
        system: (systemPaise / 100).toFixed(2),
      },
    });
  }

  return res.status(201).json({
    id, date, drawer_amount_paise: drawerPaise, system_amount_paise: systemPaise,
    delta_paise: deltaPaise, is_discrepancy: isDiscrepancy,
  });
}

/** GET /api/v1/reconciliation/cash */
function listReconciliations(req, res) {
  const db = getDb();
  const { from, to } = req.query;
  let q = `SELECT rc.*, u.name as submitted_by_name FROM cash_reconciliations rc
           JOIN users u ON u.id = rc.submitted_by WHERE rc.property_id = ?`;
  const params = [req.user.property_id];
  if (from) { q += ' AND rc.date >= ?'; params.push(from); }
  if (to)   { q += ' AND rc.date <= ?'; params.push(to); }
  q += ' ORDER BY rc.date DESC';
  return res.json(db.prepare(q).all(...params));
}

/** PATCH /api/v1/reconciliation/cash/:id/explain */
function explainDiscrepancy(req, res) {
  const db = getDb();
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'note is required' });

  const rec = db.prepare(
    'SELECT * FROM cash_reconciliations WHERE id = ? AND property_id = ?'
  ).get(req.params.id, req.user.property_id);
  if (!rec) return res.status(404).json({ error: 'Reconciliation not found' });

  db.prepare('UPDATE cash_reconciliations SET owner_note = ? WHERE id = ?').run(note.trim(), req.params.id);
  return res.json({ message: 'Note saved', id: req.params.id });
}

module.exports = { closeCashDrawer, listReconciliations, explainDiscrepancy };
