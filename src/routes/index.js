'use strict';

/**
 * DormBook API Routes — v2.1
 * Base path: /api/v1  (mounted in server.js)
 *
 * Role ladder: owner(3) > manager(2) > reception(1)
 * requireRole(X) = user.role_weight >= X.weight
 */

const express = require('express');
const router  = express.Router();

const { authenticate, requireRole, sameProperty, assertOwnsResource } = require('../middleware/auth');

const auth       = require('../controllers/authController');
const beds       = require('../controllers/bedsController');
const checkin    = require('../controllers/checkinController');
const payments   = require('../controllers/paymentsController');
const finance    = require('../controllers/financeController');
const staff      = require('../controllers/staffController');
const bookings   = require('../controllers/bookingsController');
const reconcile  = require('../controllers/reconciliationController');
const addons     = require('../controllers/addonsController');
const feedback   = require('../controllers/feedbackController');
const receipts   = require('../controllers/receiptsController');

// ── Auth ──────────────────────────────────────────────────────────────────
router.post('/auth/login',           auth.login);
router.get ('/auth/me',              authenticate, auth.me);
router.post('/auth/change-password', authenticate, auth.changePassword);

// ── Dashboard ─────────────────────────────────────────────────────────────
// Reception gets occupancy only; manager+ gets financial widgets (enforced in handler)
router.get('/dashboard/summary',     authenticate, sameProperty, finance.getDashboard);

// ── Beds ─────────────────────────────────────────────────────────────────
router.get  ('/beds',                authenticate, sameProperty, beds.listBeds);
router.post ('/beds',                authenticate, sameProperty, requireRole('manager'), beds.createBed);
router.get  ('/beds/:id',            authenticate, sameProperty, beds.getBed);
router.patch('/beds/:id/status',     authenticate, sameProperty, requireRole('reception'), beds.updateBedStatus);
// NEW: Owner/Manager sets the base monthly rate for a bed
router.patch('/beds/:id/rate',       authenticate, sameProperty, requireRole('manager'), beds.updateBedRate);
// NEW: Bulk rate update for multiple beds
router.patch('/beds/bulk-rate',      authenticate, sameProperty, requireRole('manager'), beds.bulkUpdateBedRate);
router.get  ('/floors',              authenticate, sameProperty, beds.listFloors);

// ── Residents ─────────────────────────────────────────────────────────────
router.post('/residents',                        authenticate, sameProperty, requireRole('reception'), checkin.checkIn);
router.get ('/residents',                        authenticate, sameProperty, checkin.listResidents);
router.get ('/residents/:id',                    authenticate, sameProperty, assertOwnsResource('residents'), checkin.getResident);
router.post('/residents/:id/checkout',           authenticate, sameProperty, requireRole('reception'), assertOwnsResource('residents'), checkin.checkOut);
router.post('/residents/:id/checkout/approve',   authenticate, sameProperty, requireRole('manager'),   assertOwnsResource('residents'), checkin.approveCheckout);
router.post('/residents/:id/extend',             authenticate, sameProperty, requireRole('manager'),   assertOwnsResource('residents'), checkin.extendStay);
// NEW: Change rent for active resident without extending checkout
router.patch('/residents/:id/rent',              authenticate, sameProperty, requireRole('manager'),   assertOwnsResource('residents'), checkin.updateResidentRent);

// Resident ledger & refund
router.get ('/residents/:id/ledger',             authenticate, sameProperty, assertOwnsResource('residents'), payments.getResidentLedger);
router.post('/residents/:id/refund-deductions',  authenticate, sameProperty, requireRole('manager'), assertOwnsResource('residents'), payments.addRefundDeduction);
router.get ('/residents/:id/refund-summary',     authenticate, sameProperty, assertOwnsResource('residents'), payments.getRefundSummary);
router.get ('/residents/:id/addons',             authenticate, sameProperty, addons.getResidentAddons);
router.post('/residents/:id/addons',             authenticate, sameProperty, requireRole('reception'), addons.addAddonCharge);

// ── Payments ─────────────────────────────────────────────────────────────
router.post('/payments',                         authenticate, sameProperty, requireRole('reception'), payments.recordPayment);
router.get ('/payments/pending-approvals',       authenticate, sameProperty, requireRole('manager'), payments.pendingApprovals);
router.post('/payments/:id/approve',             authenticate, sameProperty, requireRole('manager'), assertOwnsResource('payment_ledger'), payments.approvePayment);

// ── Finance — manager+ for reports, owner-only for export & audit ─────────
router.get   ('/expenses',           authenticate, sameProperty, requireRole('manager'), finance.listExpenses);
router.post  ('/expenses',           authenticate, sameProperty, requireRole('manager'), finance.addExpense);
// NEW: Edit and delete expenses (owner only)
router.patch ('/expenses/:id',       authenticate, sameProperty, requireRole('owner'), finance.updateExpense);
router.delete('/expenses/:id',       authenticate, sameProperty, requireRole('owner'), finance.deleteExpense);
router.get   ('/reports/summary',    authenticate, sameProperty, requireRole('manager'), finance.reportSummary);
router.get   ('/reports/export',     authenticate, sameProperty, requireRole('owner'),   finance.reportExport);
router.get   ('/audit',              authenticate, sameProperty, requireRole('owner'),   finance.getAuditLog);

// ── Property Settings (owner only) ────────────────────────────────────────
// NEW: Owner can update property config (cleaning timeout, refund threshold, WhatsApp number, etc.)
router.patch('/properties/settings', authenticate, sameProperty, requireRole('owner'), finance.updatePropertySettings);

// ── Staff ─────────────────────────────────────────────────────────────────
router.get   ('/staff',              authenticate, sameProperty, requireRole('manager'), staff.listStaff);
router.post  ('/staff',              authenticate, sameProperty, requireRole('owner'),   staff.inviteStaff);
router.patch ('/staff/:id',          authenticate, sameProperty, requireRole('owner'),   staff.updateStaff);
router.delete('/staff/:id',          authenticate, sameProperty, requireRole('owner'),   staff.deactivateStaff);

// ── Bookings (bed-lock / Module 10) ───────────────────────────────────────
router.post('/bookings',                         authenticate, sameProperty, requireRole('reception'), bookings.createBooking);
router.get ('/bookings',                         authenticate, sameProperty, requireRole('reception'), bookings.listBookings);
router.post('/bookings/:id/confirm',             authenticate, sameProperty, requireRole('manager'),   bookings.confirmBooking);
router.post('/bookings/:id/cancel',              authenticate, sameProperty, requireRole('reception'), bookings.cancelBooking);
router.post('/bookings/release-expired',         authenticate, sameProperty, requireRole('manager'),   bookings.releaseExpired);

// ── Cash Reconciliation (Module 13) ──────────────────────────────────────
router.post  ('/reconciliation/cash',            authenticate, sameProperty, requireRole('reception'), reconcile.closeCashDrawer);
router.get   ('/reconciliation/cash',            authenticate, sameProperty, requireRole('manager'),   reconcile.listReconciliations);
router.patch ('/reconciliation/cash/:id/explain',authenticate, sameProperty, requireRole('owner'),     reconcile.explainDiscrepancy);

// ── Add-on Catalog (Module 15) ────────────────────────────────────────────
router.get   ('/addons/catalog',     authenticate, sameProperty, addons.getCatalog);
router.post  ('/addons/catalog',     authenticate, sameProperty, requireRole('owner'),   addons.createCatalogItem);
router.patch ('/addons/catalog/:id', authenticate, sameProperty, requireRole('owner'),   addons.updateCatalogItem);

// ── Feedback (Module 9) ──────────────────────────────────────────────────
// /feedback/rate is called by WhatsApp webhook — uses CRON_SECRET header instead of JWT
router.post('/feedback/rate',        verifyWebhookSecret, feedback.rateFeedback);
router.get ('/feedback',             authenticate, sameProperty, requireRole('owner'),   feedback.listFeedback);
router.patch('/feedback/:id/resolve',authenticate, sameProperty, requireRole('manager'), feedback.resolveFeedback);

// ── Receipts (Module 14) ─────────────────────────────────────────────────
router.get('/receipts/:receipt_number',         authenticate, sameProperty, receipts.getReceipt);
router.post('/receipts/:receipt_number/resend', authenticate, sameProperty, requireRole('reception'), receipts.resendReceipt);
router.get('/receipts/:receipt_number/pdf',     authenticate, sameProperty, receipts.downloadReceiptPdf);

// ── Cron endpoints (called by Railway/external scheduler) ─────────────────
router.post('/cron/release-expired-bookings', verifyCronSecret, bookings.releaseExpired);
router.post('/cron/eod-report',               verifyCronSecret, (req, res) => {
  require('../services/scheduler').startScheduler;
  const { scheduleWhatsApp } = require('../services/whatsappService');
  res.json({ message: 'EOD triggered' });
});

// ─── Middleware helpers ────────────────────────────────────────────────────
function verifyCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  next();
}

function verifyWebhookSecret(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  next();
}

// ── Health check ─────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.1.0', timestamp: new Date().toISOString() });
});

module.exports = router;
