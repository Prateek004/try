'use strict';

/**
 * DormBook Cron Scheduler
 *
 * All jobs run server-local timezone. For production use Railway cron
 * or an external scheduler (e.g. Render Cron Jobs) to invoke the API
 * endpoints directly — that allows stateless horizontal scaling.
 *
 * Jobs defined here as in-process fallback for single-instance deploys.
 */

const cron = require('node-cron');
const { getDb } = require('../db/connection');
const { scheduleWhatsApp } = require('./whatsappService');

let isStarted = false;

function startScheduler() {
  if (isStarted) return;
  isStarted = true;
  console.log('[SCHEDULER] Starting all cron jobs');

  // ── 1. Rent reminders — daily at 09:00 ──────────────────
  cron.schedule('0 9 * * *', sendTieredRentReminders, { name: 'rent-reminders' });

  // ── 2. EOD report — daily at 22:00 ───────────────────────
  cron.schedule('0 22 * * *', sendEodReport, { name: 'eod-report' });

  // ── 3. Cleaning timeout — every 30 min ───────────────────
  cron.schedule('*/30 * * * *', revertCleanedBeds, { name: 'cleaning-timeout' });

  // ── 4. Booking expiry — every 15 min ─────────────────────
  cron.schedule('*/15 * * * *', releaseExpiredBookings, { name: 'booking-expiry' });

  // ── 5. Overstay alert — daily at 10:00 ───────────────────
  cron.schedule('0 10 * * *', sendOverstayAlerts, { name: 'overstay-alerts' });

  // NOTE: Removed generateMonthlyInvoices cron job.
  // It was creating ₹0 phantom ledger entries (type='rent', amount=0, direction='credit')
  // that corrupted revenue reports and blocked real invoice generation.
  // Billing obligations are derived from residents.monthly_rent_paise — no synthetic entries needed.
}

// ── Rent Reminders (tiered: 3d before, due, 3d over, 7d over) ──────────────
/**
 * FIX: Now includes type='advance' alongside 'rent' when checking paid total.
 * Previously, advance payments at check-in were recorded as 'rent',
 * but now they're 'advance' — so both types must be summed.
 */
function sendTieredRentReminders() {
  const db    = getDb();
  const today = new Date().toISOString().substring(0, 10);
  const month = today.substring(0, 7);

  const residents = db.prepare(`
    SELECT r.id, r.full_name, r.mobile, r.monthly_rent_paise, r.rent_due_day, r.property_id,
      COALESCE((
        SELECT SUM(pl.amount_paise) FROM payment_ledger pl
        WHERE pl.resident_id = r.id AND pl.type IN ('rent','advance')
        AND pl.billing_month = ? AND pl.direction = 'credit'
      ), 0) as paid_paise
    FROM residents r
    WHERE r.status = 'active'
  `).all(month);

  const todayDate = new Date(today);

  residents.forEach(r => {
    const owed = r.monthly_rent_paise;
    if ((r.paid_paise || 0) >= owed) return; // already paid

    // Build due date for this month
    const dueDay  = r.rent_due_day || 1;
    const dueDate = new Date(`${month}-${String(dueDay).padStart(2, '0')}`);
    if (isNaN(dueDate)) return;

    const diffDays = Math.floor((todayDate - dueDate) / 86400000);
    const dueDateStr = dueDate.toISOString().substring(0, 10);

    let eventType = null;
    if (diffDays === -3) eventType = 'rent_reminder_3d';
    else if (diffDays === 0)  eventType = 'rent_due_today';
    else if (diffDays === 3)  eventType = 'rent_overdue_3d';
    else if (diffDays === 7)  eventType = 'rent_overdue_7d';

    if (!eventType) return;

    const data = { name: r.full_name, amount: owed / 100, due_date: dueDateStr, days_overdue: Math.max(0, diffDays) };
    scheduleWhatsApp({ propertyId: r.property_id, residentId: r.id, recipientMobile: r.mobile, recipientType: 'tenant', eventType, templateData: data })
      .catch(err => console.error('[SCHEDULER] Reminder error:', err.message));

    // 7d overdue → also alert owner
    if (diffDays >= 7) {
      scheduleWhatsApp({ propertyId: r.property_id, residentId: r.id, recipientMobile: '', recipientType: 'owner', eventType: 'rent_overdue_7d', templateData: { ...data, mobile: r.mobile } })
        .catch(err => console.error('[SCHEDULER] Owner alert error:', err.message));
    }
  });

  console.log(`[SCHEDULER] Rent reminders processed for ${residents.length} residents`);
}

// ── EOD Report ──────────────────────────────────────────────────────────────
/**
 * FIX: Replaced COUNT(*) FILTER (WHERE ...) with SUM(CASE WHEN ... END)
 * for SQLite compatibility.
 */
function sendEodReport() {
  const db    = getDb();
  const today = new Date().toISOString().substring(0, 10);

  const properties = db.prepare('SELECT * FROM properties').all();
  properties.forEach(prop => {
    const collection = db.prepare(`
      SELECT COALESCE(SUM(amount_paise),0) as total FROM payment_ledger
      WHERE property_id=? AND direction='credit' AND date(paid_at)=?
    `).get(prop.id, today);

    const occupancy = db.prepare(`
      SELECT
        SUM(CASE WHEN status='occupied'  THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) as available,
        COUNT(*) as total
      FROM beds WHERE property_id=?
    `).get(prop.id);

    const overdue = db.prepare(`
      SELECT COUNT(*) as count FROM residents r
      WHERE r.property_id=? AND r.status='active'
      AND (
        SELECT COALESCE(SUM(pl.amount_paise),0) FROM payment_ledger pl
        WHERE pl.resident_id=r.id AND pl.type IN ('rent','advance') AND pl.billing_month=?
      ) < r.monthly_rent_paise
    `).get(prop.id, today.substring(0,7));

    scheduleWhatsApp({
      propertyId: prop.id, residentId: null,
      recipientMobile: prop.whatsapp_number || '', recipientType: 'owner',
      eventType: 'eod_report',
      templateData: {
        date: today, collection: collection.total / 100,
        occupied: occupancy.occupied || 0, available: occupancy.available || 0,
        overdue: overdue.count,
      },
    }).catch(err => console.error('[SCHEDULER] EOD error:', err.message));
  });
}

// ── Cleaning Timeout — revert beds that have been cleaning too long ─────────
function revertCleanedBeds() {
  const db = getDb();
  const properties = db.prepare('SELECT id, cleaning_timeout_minutes FROM properties').all();

  properties.forEach(prop => {
    const timeoutMins = prop.cleaning_timeout_minutes || 120;
    const cutoff = new Date(Date.now() - timeoutMins * 60 * 1000).toISOString();

    const { changes } = db.prepare(`
      UPDATE beds SET status='available', cleaning_started_at=NULL, updated_at=datetime('now')
      WHERE property_id=? AND status='cleaning' AND cleaning_started_at < ?
    `).run(prop.id, cutoff);

    if (changes > 0) console.log(`[SCHEDULER] Reverted ${changes} bed(s) to available for property ${prop.id}`);
  });
}

// ── Booking Expiry ──────────────────────────────────────────────────────────
function releaseExpiredBookings() {
  const db = getDb();
  const expired = db.prepare(
    "SELECT * FROM booking_requests WHERE status='pending' AND lock_expires_at < datetime('now')"
  ).all();

  if (!expired.length) return;

  db.transaction(() => {
    expired.forEach(b => {
      db.prepare("UPDATE booking_requests SET status='expired' WHERE id=?").run(b.id);
      db.prepare("UPDATE beds SET status='available', booking_request_id=NULL, updated_at=datetime('now') WHERE id=?").run(b.bed_id);
    });
  })();

  console.log(`[SCHEDULER] Released ${expired.length} expired booking(s)`);
}

// ── Overstay Alerts ─────────────────────────────────────────────────────────
/**
 * FIX: Uses distinct 'overstay_alert' event type instead of reusing 'rent_overdue_7d'.
 * The owner gets a clear message about checkout being overdue, not a confusing rent reminder.
 */
function sendOverstayAlerts() {
  const db    = getDb();
  const today = new Date().toISOString().substring(0, 10);

  const overstayers = db.prepare(`
    SELECT r.id, r.full_name, r.mobile, r.expected_checkout, r.property_id
    FROM residents r
    WHERE r.status='active' AND r.expected_checkout < ?
  `).all(today);

  overstayers.forEach(r => {
    const days = Math.floor((new Date(today) - new Date(r.expected_checkout)) / 86400000);
    console.warn(`[SCHEDULER] Overstay: ${r.full_name} (${days} days past checkout ${r.expected_checkout})`);
    // Alert owner with distinct event type
    scheduleWhatsApp({
      propertyId: r.property_id, residentId: r.id,
      recipientMobile: '', recipientType: 'owner',
      eventType: 'overstay_alert',
      templateData: { name: r.full_name, expected_checkout: r.expected_checkout, days_overdue: days },
    }).catch(() => {});
  });

  if (overstayers.length) console.log(`[SCHEDULER] Overstay alerts sent for ${overstayers.length} resident(s)`);
}

module.exports = { startScheduler };
