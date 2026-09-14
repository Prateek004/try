'use strict';

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

// ── Auth ──────────────────────────────────────────────────
router.post('/auth/login',           auth.login);
router.get ('/auth/me',              authenticate, auth.me);
router.post('/auth/change-password', authenticate, auth.changePassword);

// ── Dashboard ─────────────────────────────────────────────
router.get('/dashboard/summary', authenticate, sameProperty, finance.getDashboard);

// ── Property Setup (floors, rooms) ────────────────────────
router.get  ('/floors',          authenticate, sameProperty, beds.listFloors);
router.post ('/floors',          authenticate, sameProperty, requireRole('owner'),   beds.addFloor);
router.post ('/rooms',           authenticate, sameProperty, requireRole('owner'),   beds.addRoom);

// ── Beds ──────────────────────────────────────────────────
router.get  ('/beds',            authenticate, sameProperty, beds.listBeds);
router.post ('/beds',            authenticate, sameProperty, requireRole('manager'), beds.createBed);
router.get  ('/beds/:id',        authenticate, sameProperty, beds.getBed);
router.patch('/beds/:id/status', authenticate, sameProperty, requireRole('reception'), beds.updateBedStatus);
router.patch('/beds/:id/rate',   authenticate, sameProperty, requireRole('owner'), beds.updateBedRate);
router.patch('/beds/bulk-rate',  authenticate, sameProperty, requireRole('owner'), beds.bulkUpdateBedRate);

// ── Residents ─────────────────────────────────────────────
router.post('/residents',                        authenticate, sameProperty, requireRole('reception'), checkin.checkIn);
router.get ('/residents',                        authenticate, sameProperty, checkin.listResidents);
router.get ('/residents/:id',                    authenticate, sameProperty, assertOwnsResource('residents'), checkin.getResident);
router.post('/residents/:id/checkout',           authenticate, sameProperty, requireRole('reception'), assertOwnsResource('residents'), checkin.checkOut);
router.post('/residents/:id/checkout/approve',   authenticate, sameProperty, requireRole('manager'),   assertOwnsResource('residents'), checkin.approveCheckout);
router.post('/residents/:id/extend',             authenticate, sameProperty, requireRole('manager'),   assertOwnsResource('residents'), checkin.extendStay);
router.patch('/residents/:id/rent',              authenticate, sameProperty, requireRole('manager'),   assertOwnsResource('residents'), checkin.updateResidentRent);

// ── Resident ledger & refund ──────────────────────────────
router.get ('/residents/:id/ledger',             authenticate, sameProperty, assertOwnsResource('residents'), payments.getResidentLedger);
router.post('/residents/:id/refund-deductions',  authenticate, sameProperty, requireRole('manager'), assertOwnsResource('residents'), payments.addRefundDeduction);
router.get ('/residents/:id/refund-summary',     authenticate, sameProperty, assertOwnsResource('residents'), payments.getRefundSummary);
router.get ('/residents/:id/addons',             authenticate, sameProperty, addons.getResidentAddons);
router.post('/residents/:id/addons',             authenticate, sameProperty, requireRole('reception'), addons.addAddonCharge);

// ── Payments ──────────────────────────────────────────────
router.post('/payments',                   authenticate, sameProperty, requireRole('reception'), payments.recordPayment);
router.get ('/payments/pending-approvals', authenticate, sameProperty, requireRole('manager'), payments.pendingApprovals);
router.post('/payments/:id/approve',       authenticate, sameProperty, requireRole('manager'), assertOwnsResource('payment_ledger'), payments.approvePayment);

// ── Finance ───────────────────────────────────────────────
router.get   ('/expenses',           authenticate, sameProperty, requireRole('manager'), finance.listExpenses);
router.post  ('/expenses',           authenticate, sameProperty, requireRole('manager'), finance.addExpense);
router.patch ('/expenses/:id',       authenticate, sameProperty, requireRole('owner'), finance.updateExpense);
router.delete('/expenses/:id',       authenticate, sameProperty, requireRole('owner'), finance.deleteExpense);
router.get   ('/reports/summary',    authenticate, sameProperty, requireRole('manager'), finance.reportSummary);
router.get   ('/reports/export',     authenticate, sameProperty, requireRole('owner'),   finance.reportExport);
router.get   ('/audit',              authenticate, sameProperty, requireRole('owner'),   finance.getAuditLog);

// ── Property Settings ─────────────────────────────────────
router.patch('/properties/settings', authenticate, sameProperty, requireRole('owner'), finance.updatePropertySettings);

// ── Staff ─────────────────────────────────────────────────
router.get   ('/staff',    authenticate, sameProperty, requireRole('manager'), staff.listStaff);
router.post  ('/staff',    authenticate, sameProperty, requireRole('owner'),   staff.inviteStaff);
router.patch ('/staff/:id',authenticate, sameProperty, requireRole('owner'),   staff.updateStaff);
router.delete('/staff/:id',authenticate, sameProperty, requireRole('owner'),   staff.deactivateStaff);

// ── Bookings ──────────────────────────────────────────────
router.post('/bookings',                 authenticate, sameProperty, requireRole('reception'), bookings.createBooking);
router.get ('/bookings',                 authenticate, sameProperty, requireRole('reception'), bookings.listBookings);
router.post('/bookings/:id/confirm',     authenticate, sameProperty, requireRole('manager'),   bookings.confirmBooking);
router.post('/bookings/:id/cancel',      authenticate, sameProperty, requireRole('reception'), bookings.cancelBooking);
router.post('/bookings/release-expired', authenticate, sameProperty, requireRole('manager'),   bookings.releaseExpired);

// ── Cash Reconciliation ──────────────────────────────────
router.post  ('/reconciliation/cash',             authenticate, sameProperty, requireRole('reception'), reconcile.closeCashDrawer);
router.get   ('/reconciliation/cash',             authenticate, sameProperty, requireRole('manager'),   reconcile.listReconciliations);
router.patch ('/reconciliation/cash/:id/explain', authenticate, sameProperty, requireRole('owner'),     reconcile.explainDiscrepancy);

// ── Add-on Catalog ────────────────────────────────────────
router.get   ('/addons/catalog',     authenticate, sameProperty, addons.getCatalog);
router.post  ('/addons/catalog',     authenticate, sameProperty, requireRole('owner'), addons.createCatalogItem);
router.patch ('/addons/catalog/:id', authenticate, sameProperty, requireRole('owner'), addons.updateCatalogItem);

// ── Feedback ──────────────────────────────────────────────
router.post('/feedback/rate',         verifyWebhookSecret, feedback.rateFeedback);
router.get ('/feedback',              authenticate, sameProperty, requireRole('owner'), feedback.listFeedback);
router.patch('/feedback/:id/resolve', authenticate, sameProperty, requireRole('manager'), feedback.resolveFeedback);

// ── Receipts ──────────────────────────────────────────────
router.get ('/receipts/:receipt_number',         authenticate, sameProperty, receipts.getReceipt);
router.post('/receipts/:receipt_number/resend',  authenticate, sameProperty, requireRole('reception'), receipts.resendReceipt);
router.get ('/receipts/:receipt_number/pdf',     authenticate, sameProperty, receipts.downloadReceiptPdf);

// ── Cron endpoints ────────────────────────────────────────
router.post('/cron/release-expired-bookings', verifyCronSecret, bookings.releaseExpired);

function verifyCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) return res.status(401).json({ error: 'Invalid cron secret' });
  next();
}
function verifyWebhookSecret(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ error: 'Invalid webhook secret' });
  next();
}

router.get('/health', (req, res) => res.json({ status: 'ok', version: '3.0.0', timestamp: new Date().toISOString() }));

module.exports = router;
