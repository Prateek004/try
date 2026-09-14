'use strict';

const ExcelJS  = require('exceljs');
const PDFKit   = require('pdfkit');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');

/**
 * GET /api/v1/dashboard/summary
 *
 * FIX: Replaced COUNT(*) FILTER (WHERE ...) with SUM(CASE WHEN ... END).
 * FILTER syntax is PostgreSQL-native and only works in SQLite ≥ 3.30.0.
 * SUM(CASE) works on every SQLite version — eliminates the "shows 0" bug
 * if the bundled SQLite is older.
 */
function getDashboard(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const today      = new Date().toISOString().substring(0, 10);
  const thisMonth  = today.substring(0, 7);

  const occupancy = db.prepare(`
    SELECT
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN status='occupied'  THEN 1 ELSE 0 END) as occupied,
      SUM(CASE WHEN status='cleaning'  THEN 1 ELSE 0 END) as cleaning,
      SUM(CASE WHEN status='reserved'  THEN 1 ELSE 0 END) as reserved,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) as pending,
      COUNT(*)                                              as total
    FROM beds WHERE property_id = ?
  `).get(propertyId);

  const activeResidents = db.prepare(
    "SELECT COUNT(*) as count FROM residents WHERE property_id = ? AND status = 'active'"
  ).get(propertyId);

  const pendingRefunds = db.prepare(
    "SELECT COUNT(*) as count, COALESCE(SUM(amount_paise),0) as total_paise FROM payment_ledger WHERE property_id = ? AND approval_status = 'pending'"
  ).get(propertyId);

  let financial = null;
  // Only expose financial data to manager+ roles
  if (req.user.role !== 'reception') {
    const todayCollection = db.prepare(`
      SELECT COALESCE(SUM(amount_paise),0) as total_paise FROM payment_ledger
      WHERE property_id = ? AND direction='credit' AND date(paid_at) = ?
    `).get(propertyId, today);

    const monthlyRevenue = db.prepare(`
      SELECT COALESCE(SUM(amount_paise),0) as total_paise FROM payment_ledger
      WHERE property_id = ? AND direction='credit' AND billing_month = ?
    `).get(propertyId, thisMonth);

    const monthlyExpenses = db.prepare(`
      SELECT COALESCE(SUM(amount_paise),0) as total_paise FROM expenses
      WHERE property_id = ? AND strftime('%Y-%m', expense_date) = ?
    `).get(propertyId, thisMonth);

    const overdueResidents = db.prepare(`
      SELECT COUNT(*) as count FROM residents r
      WHERE r.property_id = ? AND r.status = 'active'
      AND (
        SELECT COALESCE(SUM(pl.amount_paise),0) FROM payment_ledger pl
        WHERE pl.resident_id = r.id AND pl.type IN ('rent','advance') AND pl.direction='credit'
        AND pl.billing_month = ?
      ) < r.monthly_rent_paise
    `).get(propertyId, thisMonth);

    financial = {
      today_collection_paise:    todayCollection.total_paise,
      monthly_revenue_paise:     monthlyRevenue.total_paise,
      monthly_expenses_paise:    monthlyExpenses.total_paise,
      monthly_net_paise:         monthlyRevenue.total_paise - monthlyExpenses.total_paise,
      overdue_residents:         overdueResidents.count,
    };
  }

  const data = {
    occupancy,
    active_residents: activeResidents.count,
    pending_refunds:  pendingRefunds.count,
    pending_refunds_total_paise: pendingRefunds.total_paise,
    ...(financial || { note: 'Financial data restricted to manager and above' }),
  };

  return res.json(data);
}

/** GET /api/v1/expenses */
function listExpenses(req, res) {
  const db = getDb();
  const { from, to, category } = req.query;
  let q = 'SELECT e.*, u.name as recorded_by_name FROM expenses e JOIN users u ON u.id=e.recorded_by WHERE e.property_id=?';
  const params = [req.user.property_id];
  if (from)     { q += ' AND e.expense_date >= ?'; params.push(from); }
  if (to)       { q += ' AND e.expense_date <= ?'; params.push(to); }
  if (category) { q += ' AND e.category = ?'; params.push(category); }
  q += ' ORDER BY e.expense_date DESC';
  return res.json(db.prepare(q).all(...params));
}

/** POST /api/v1/expenses */
function addExpense(req, res) {
  const { v4: uuidv4 } = require('uuid');
  const db = getDb();
  const propertyId = req.user.property_id;
  const { category, description, amount_paise, expense_date, payment_mode, receipt_path } = req.body;

  if (!category || !amount_paise || !expense_date) {
    return res.status(400).json({ error: 'category, amount_paise, expense_date are required' });
  }
  const amtPaise = Math.round(parseFloat(amount_paise));
  if (amtPaise <= 0) return res.status(400).json({ error: 'amount_paise must be > 0' });

  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO expenses (id,property_id,category,description,amount_paise,expense_date,payment_mode,receipt_path,recorded_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, propertyId, category, description || null, amtPaise, expense_date,
    payment_mode || 'cash', receipt_path || null, req.user.id, now);

  writeAudit({
    propertyId, userId: req.user.id, action: 'EXPENSE_RECORDED',
    entityType: 'expenses', entityId: id,
    amountPaise: amtPaise,
    snapshot: { category, expense_date, mode: payment_mode },
    ip: req.ip,
  });

  return res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
}

/**
 * PATCH /api/v1/expenses/:id
 * Fix a wrong expense entry. Owner only.
 */
function updateExpense(req, res) {
  const { v4: uuidv4 } = require('uuid');
  const db = getDb();
  const propertyId = req.user.property_id;

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND property_id = ?')
    .get(req.params.id, propertyId);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });

  const { category, description, amount_paise, expense_date, payment_mode } = req.body;

  const newAmount = amount_paise !== undefined ? Math.round(parseFloat(amount_paise)) : expense.amount_paise;
  if (newAmount <= 0) return res.status(400).json({ error: 'amount_paise must be > 0' });

  db.prepare(`
    UPDATE expenses SET category=COALESCE(?,category), description=COALESCE(?,description),
    amount_paise=?, expense_date=COALESCE(?,expense_date), payment_mode=COALESCE(?,payment_mode)
    WHERE id=?
  `).run(
    category || null, description !== undefined ? description : null,
    newAmount, expense_date || null, payment_mode || null, req.params.id
  );

  writeAudit({
    propertyId, userId: req.user.id, action: 'EXPENSE_UPDATED',
    entityType: 'expenses', entityId: req.params.id,
    amountPaise: newAmount,
    snapshot: { old: expense, updated_fields: req.body },
    ip: req.ip,
  });

  return res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id));
}

/**
 * DELETE /api/v1/expenses/:id
 * Remove a wrong expense entry. Owner only.
 */
function deleteExpense(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND property_id = ?')
    .get(req.params.id, propertyId);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });

  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);

  writeAudit({
    propertyId, userId: req.user.id, action: 'EXPENSE_DELETED',
    entityType: 'expenses', entityId: req.params.id,
    amountPaise: expense.amount_paise,
    snapshot: expense,
    ip: req.ip,
  });

  return res.json({ message: 'Expense deleted' });
}

/**
 * PATCH /api/v1/properties/settings
 * Owner updates property configuration.
 */
function updatePropertySettings(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;

  const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  if (!prop) return res.status(404).json({ error: 'Property not found' });

  const {
    name, address, city, state, pincode, whatsapp_number,
    cleaning_timeout_minutes, refund_approval_threshold_paise,
    daily_summary_time, eod_report_time, timezone,
    cash_reconciliation_tolerance_paise, booking_lock_hours, property_code,
  } = req.body;

  db.prepare(`
    UPDATE properties SET
      name=COALESCE(?,name), address=COALESCE(?,address), city=COALESCE(?,city),
      state=COALESCE(?,state), pincode=COALESCE(?,pincode),
      whatsapp_number=COALESCE(?,whatsapp_number),
      cleaning_timeout_minutes=COALESCE(?,cleaning_timeout_minutes),
      refund_approval_threshold_paise=COALESCE(?,refund_approval_threshold_paise),
      daily_summary_time=COALESCE(?,daily_summary_time),
      eod_report_time=COALESCE(?,eod_report_time),
      timezone=COALESCE(?,timezone),
      cash_reconciliation_tolerance_paise=COALESCE(?,cash_reconciliation_tolerance_paise),
      booking_lock_hours=COALESCE(?,booking_lock_hours),
      property_code=COALESCE(?,property_code),
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    name || null, address || null, city || null, state || null, pincode || null,
    whatsapp_number || null,
    cleaning_timeout_minutes !== undefined ? cleaning_timeout_minutes : null,
    refund_approval_threshold_paise !== undefined ? refund_approval_threshold_paise : null,
    daily_summary_time || null, eod_report_time || null, timezone || null,
    cash_reconciliation_tolerance_paise !== undefined ? cash_reconciliation_tolerance_paise : null,
    booking_lock_hours !== undefined ? booking_lock_hours : null,
    property_code || null,
    propertyId
  );

  writeAudit({
    propertyId, userId: req.user.id, action: 'PROPERTY_SETTINGS_UPDATED',
    entityType: 'properties', entityId: propertyId,
    snapshot: { updated_fields: req.body },
    ip: req.ip,
  });

  return res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId));
}

/** GET /api/v1/reports/summary */
function reportSummary(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { from = new Date().toISOString().substring(0,7) + '-01', to = new Date().toISOString().substring(0,10) } = req.query;

  const revenue = db.prepare(`
    SELECT type, COALESCE(SUM(amount_paise),0) as total_paise
    FROM payment_ledger WHERE property_id=? AND direction='credit'
    AND date(paid_at) BETWEEN ? AND ?
    GROUP BY type
  `).all(propertyId, from, to);

  const expenses = db.prepare(`
    SELECT category, COALESCE(SUM(amount_paise),0) as total_paise
    FROM expenses WHERE property_id=? AND expense_date BETWEEN ? AND ?
    GROUP BY category
  `).all(propertyId, from, to);

  const totalRevenue  = revenue.reduce((s, r) => s + r.total_paise, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.total_paise, 0);

  const payments = db.prepare(`
    SELECT pl.*, r.full_name as resident_name
    FROM payment_ledger pl JOIN residents r ON r.id=pl.resident_id
    WHERE pl.property_id=? AND direction='credit' AND date(pl.paid_at) BETWEEN ? AND ?
    ORDER BY pl.paid_at DESC
  `).all(propertyId, from, to);

  return res.json({
    from, to, total_revenue_paise: totalRevenue,
    total_expenses_paise: totalExpenses, net_paise: totalRevenue - totalExpenses,
    revenue_by_type: revenue, expenses_by_category: expenses, payments,
  });
}

/** GET /api/v1/reports/export  – owner only (enforced at route level) */
async function reportExport(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const {
    from = new Date().toISOString().substring(0,7) + '-01',
    to   = new Date().toISOString().substring(0,10),
    format = 'xlsx',
  } = req.query;

  const payments = db.prepare(`
    SELECT pl.paid_at, pl.type, pl.direction, pl.amount_paise, pl.payment_mode,
           pl.billing_month, pl.approval_status, pl.notes,
           r.full_name as resident_name, r.mobile as resident_mobile,
           b.bed_label, rm.room_number, f.label as floor_label
    FROM payment_ledger pl
    JOIN residents r ON r.id = pl.resident_id
    LEFT JOIN beds b  ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE pl.property_id=? AND date(pl.paid_at) BETWEEN ? AND ?
    ORDER BY pl.paid_at DESC
  `).all(propertyId, from, to);

  const expenses = db.prepare(`
    SELECT expense_date, category, description, amount_paise, payment_mode
    FROM expenses WHERE property_id=? AND expense_date BETWEEN ? AND ?
    ORDER BY expense_date DESC
  `).all(propertyId, from, to);

  const filename = `dormbook-report-${from}-to-${to}`;

  if (format === 'csv') {
    const header = 'Date,Resident,Room/Bed,Type,Direction,Amount (₹),Mode,Billing Month,Notes\n';
    const rows = payments.map(p =>
      [p.paid_at.substring(0,10), p.resident_name, `${p.room_number||''} ${p.bed_label||''}`.trim(),
       p.type, p.direction, (p.amount_paise/100).toFixed(2), p.payment_mode, p.billing_month||'', p.notes||'']
      .map(v => `"${String(v).replace(/"/g,'""')}"`)
      .join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(header + rows);
  }

  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'DormBook';
    const ws = wb.addWorksheet('Payments');
    ws.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Resident', key: 'resident', width: 22 },
      { header: 'Bed', key: 'bed', width: 14 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'Direction', key: 'direction', width: 10 },
      { header: 'Amount (₹)', key: 'amount', width: 14 },
      { header: 'Mode', key: 'mode', width: 12 },
      { header: 'Billing Month', key: 'billing_month', width: 14 },
      { header: 'Approval', key: 'approval', width: 14 },
      { header: 'Notes', key: 'notes', width: 30 },
    ];
    payments.forEach(p => ws.addRow({
      date: p.paid_at.substring(0,10), resident: p.resident_name,
      bed: `${p.room_number||''} ${p.bed_label||''}`.trim(),
      type: p.type, direction: p.direction, amount: p.amount_paise / 100,
      mode: p.payment_mode, billing_month: p.billing_month || '',
      approval: p.approval_status, notes: p.notes || '',
    }));

    const ws2 = wb.addWorksheet('Expenses');
    ws2.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Description', key: 'description', width: 30 },
      { header: 'Amount (₹)', key: 'amount', width: 14 },
      { header: 'Mode', key: 'mode', width: 12 },
    ];
    expenses.forEach(e => ws2.addRow({
      date: e.expense_date, category: e.category,
      description: e.description || '', amount: e.amount_paise / 100, mode: e.payment_mode,
    }));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    const buf = await wb.xlsx.writeBuffer();
    return res.send(buf);
  }

  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    const doc = new PDFKit({ margin: 40 });
    doc.pipe(res);
    doc.fontSize(16).text('DormBook — Financial Report', { align: 'center' });
    doc.fontSize(10).text(`Period: ${from} to ${to}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Payments', { underline: true });
    doc.moveDown(0.5);
    payments.forEach(p => {
      doc.fontSize(9).text(
        `${p.paid_at.substring(0,10)} | ${p.resident_name} | ${p.type} | ${p.direction} | ₹${(p.amount_paise/100).toFixed(2)} | ${p.payment_mode}`
      );
    });
    doc.moveDown();
    doc.fontSize(12).text('Expenses', { underline: true });
    doc.moveDown(0.5);
    expenses.forEach(e => {
      doc.fontSize(9).text(
        `${e.expense_date} | ${e.category} | ₹${(e.amount_paise/100).toFixed(2)} | ${e.description || ''}`
      );
    });
    const totalRev = payments.filter(p=>p.direction==='credit').reduce((s,p)=>s+p.amount_paise,0);
    const totalExp = expenses.reduce((s,e)=>s+e.amount_paise,0);
    doc.moveDown().fontSize(12).text(`Total Revenue: ₹${(totalRev/100).toFixed(2)}`);
    doc.text(`Total Expenses: ₹${(totalExp/100).toFixed(2)}`);
    doc.text(`Net: ₹${((totalRev-totalExp)/100).toFixed(2)}`);
    doc.end();
    return;
  }

  return res.status(400).json({ error: 'format must be csv, xlsx, or pdf' });
}

/** GET /api/v1/audit */
function getAuditLog(req, res) {
  const db = getDb();
  const { from, to, actor, entity_type } = req.query;
  let q = `
    SELECT al.*, u.name as actor_name
    FROM audit_log al JOIN users u ON u.id = al.actor_id
    WHERE al.property_id = ?
  `;
  const params = [req.user.property_id];
  if (from)        { q += ' AND date(al.created_at) >= ?'; params.push(from); }
  if (to)          { q += ' AND date(al.created_at) <= ?'; params.push(to); }
  if (actor)       { q += ' AND al.actor_id = ?';          params.push(actor); }
  if (entity_type) { q += ' AND al.entity_type = ?';       params.push(entity_type); }
  q += ' ORDER BY al.created_at DESC LIMIT 1000';
  return res.json(db.prepare(q).all(...params));
}

module.exports = {
  getDashboard, listExpenses, addExpense, updateExpense, deleteExpense,
  updatePropertySettings, reportSummary, reportExport, getAuditLog,
};
