'use strict';
/* ============================================================
   DormBook v2 — Frontend SPA
   API base: /api/v1
   All monetary display: paise ÷ 100 = rupees
   ============================================================ */

// ── Service Worker registration ──────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('[SW] Registered:', reg.scope);
        // Listen for sync complete messages
        navigator.serviceWorker.addEventListener('message', e => {
          if (e.data?.type === 'SYNC_COMPLETE') {
            toast(`Synced ${e.data.replayed} offline action(s)`, 'success');
            refreshCurrentPage();
          }
        });
      })
      .catch(err => console.warn('[SW] Registration failed:', err.message));
  });
}

// ── Offline indicator ────────────────────────────────────────
window.addEventListener('online',  () => document.getElementById('offline-indicator')?.classList.add('hidden'));
window.addEventListener('offline', () => document.getElementById('offline-indicator')?.classList.remove('hidden'));

// ── State ────────────────────────────────────────────────────
const STATE = { token: null, user: null, currentPage: null };

// ── API helper ───────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(STATE.token ? { Authorization: `Bearer ${STATE.token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`/api/v1${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}

function rupees(paise) { return `₹${(Math.round(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
// FIX: Escape strings for safe use in onclick="fn('...')" attributes
function esc(s) { return String(s || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

// ── Toast ────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const tc = document.getElementById('toast-container');
  if (!tc) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  tc.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ── Modal ────────────────────────────────────────────────────
function openModal(title, bodyHtml, { wide } = {}) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal').style.maxWidth = wide ? '720px' : '520px';
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); }
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === document.getElementById('modal-overlay')) closeModal(); });
});

// ── Navigation ───────────────────────────────────────────────
const PAGES = {
  reception: [
    { id: 'dashboard', label: '🏠 Dashboard' },
    { id: 'beds',      label: '🛏 Beds' },
    { id: 'checkin',   label: '✅ Check In' },
    { id: 'residents', label: '👥 Residents' },
    { id: 'payments',  label: '💳 Payments' },
    { id: 'addons',    label: '➕ Add-ons' },
    { id: 'bookings',  label: '📅 Bookings' },
    { id: 'reconcile', label: '🗃 Cash Close' },
  ],
  manager: [
    { id: 'dashboard', label: '🏠 Dashboard' },
    { id: 'beds',      label: '🛏 Beds' },
    { id: 'checkin',   label: '✅ Check In' },
    { id: 'residents', label: '👥 Residents' },
    { id: 'payments',  label: '💳 Payments' },
    { id: 'addons',    label: '➕ Add-ons' },
    { id: 'bookings',  label: '📅 Bookings' },
    { id: 'reconcile', label: '🗃 Cash Close' },
    { id: 'expenses',  label: '📋 Expenses' },
    { id: 'reports',   label: '📊 Reports' },
    { id: 'staff',     label: '👤 Staff' },
    { id: 'feedback',  label: '⭐ Feedback' },
  ],
  owner: [
    { id: 'dashboard', label: '🏠 Dashboard' },
    { id: 'beds',      label: '🛏 Beds' },
    { id: 'checkin',   label: '✅ Check In' },
    { id: 'residents', label: '👥 Residents' },
    { id: 'payments',  label: '💳 Payments' },
    { id: 'addons',    label: '➕ Add-ons' },
    { id: 'bookings',  label: '📅 Bookings' },
    { id: 'reconcile', label: '🗃 Cash Close' },
    { id: 'expenses',  label: '📋 Expenses' },
    { id: 'reports',   label: '📊 Reports' },
    { id: 'staff',     label: '👤 Staff' },
    { id: 'feedback',  label: '⭐ Feedback' },
    { id: 'catalog',   label: '📦 Add-on Catalog' },
    { id: 'audit',     label: '🔍 Audit Log' },
    { id: 'settings',  label: '⚙️ Settings' },
  ],
};

function buildNav() {
  const role  = STATE.user?.role || 'reception';
  const pages = PAGES[role] || PAGES.reception;
  const nav   = document.getElementById('nav-list');
  nav.innerHTML = pages.map(p => `
    <li><a href="#" data-page="${p.id}">${p.label}</a></li>
  `).join('');
  nav.querySelectorAll('[data-page]').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.page); closeSidebar(); })
  );
}

function navigate(page) {
  STATE.currentPage = page;
  document.querySelectorAll('.nav-list a').forEach(a =>
    a.classList.toggle('active', a.dataset.page === page)
  );
  document.getElementById('page-title').textContent = titleFor(page);
  document.getElementById('header-actions').innerHTML = '';
  renderPage(page);
}

function titleFor(page) {
  const map = { dashboard:'Dashboard', beds:'Beds', checkin:'Check In', residents:'Residents',
    payments:'Payments', addons:'Add-on Charges', bookings:'Bookings', reconcile:'Cash Reconciliation',
    expenses:'Expenses', reports:'Reports', staff:'Staff', feedback:'Tenant Feedback',
    catalog:'Add-on Catalog', audit:'Audit Log', settings:'Property Settings' };
  return map[page] || page;
}

function refreshCurrentPage() { if (STATE.currentPage) renderPage(STATE.currentPage); }

function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); }

// ── Auth ─────────────────────────────────────────────────────
async function init() {
  // Show loading max 4s — then always fall through to login
  const loadingTimer = setTimeout(() => showLogin(), 4000);

  try {
    const token = sessionStorage.getItem('db_token');
    const user  = JSON.parse(sessionStorage.getItem('db_user') || 'null');
    if (token && user) {
      // Validate token is still accepted by server before showing app
      STATE.token = token;
      STATE.user  = user;
      try {
        await api('GET', '/auth/me');
        clearTimeout(loadingTimer);
        showApp();
      } catch (err) {
        // Token expired or DB restarted — clear and show login
        sessionStorage.clear();
        STATE.token = null;
        STATE.user  = null;
        clearTimeout(loadingTimer);
        showLogin();
      }
    } else {
      clearTimeout(loadingTimer);
      showLogin();
    }
  } catch {
    clearTimeout(loadingTimer);
    showLogin();
  }
}

let _loginListenerAttached = false;
function showLogin() {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('main-app').classList.add('hidden');
  // Guard against duplicate event listeners on re-render
  if (!_loginListenerAttached) {
    document.getElementById('login-btn').addEventListener('click', handleLogin);
    document.getElementById('login-form').addEventListener('keydown', e => {
      if (e.key === 'Enter') handleLogin(e);
    });
    _loginListenerAttached = true;
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const data = await api('POST', '/auth/login', {
      email:    document.getElementById('login-email').value.trim(),
      password: document.getElementById('login-password').value,
    });
    STATE.token = data.token;
    STATE.user  = data.user;
    sessionStorage.setItem('db_token', data.token);
    sessionStorage.setItem('db_user',  JSON.stringify(data.user));
    showApp();
  } catch (ex) {
    const msg = ex.status === 0
      ? 'Cannot reach server. Check your connection.'
      : (ex.message || 'Login failed');
    err.textContent = msg;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

function showApp() {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  document.getElementById('user-badge').textContent = `${STATE.user.name} · ${STATE.user.role}`;
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  buildNav();
  navigate('dashboard');
  if (!navigator.onLine) document.getElementById('offline-indicator')?.classList.remove('hidden');
}

function logout() {
  sessionStorage.clear();
  STATE.token = null;
  STATE.user  = null;
  location.reload();
}

// ── Pages ────────────────────────────────────────────────────
async function renderPage(page) {
  const el = document.getElementById('page-content');
  el.innerHTML = '<div class="empty-state"><div class="loading-spinner" style="margin:0 auto"></div></div>';
  try {
    switch (page) {
      case 'dashboard': await renderDashboard(el); break;
      case 'beds':      await renderBeds(el);      break;
      case 'checkin':   renderCheckin(el);         break;
      case 'residents': await renderResidents(el); break;
      case 'payments':  await renderPayments(el);  break;
      case 'addons':    await renderAddons(el);    break;
      case 'bookings':  await renderBookings(el);  break;
      case 'reconcile': renderReconcile(el);       break;
      case 'expenses':  await renderExpenses(el);  break;
      case 'reports':   await renderReports(el);   break;
      case 'staff':     await renderStaff(el);     break;
      case 'feedback':  await renderFeedback(el);  break;
      case 'catalog':   await renderCatalog(el);   break;
      case 'audit':     await renderAudit(el);     break;
      case 'settings':  await renderSettings(el);  break;
      default:          el.innerHTML = '<div class="empty-state"><p>Page not found</p></div>';
    }
  } catch (ex) {
    el.innerHTML = `<div class="error-msg">Failed to load: ${ex.message}</div>`;
  }
}

// ── Dashboard ────────────────────────────────────────────────
async function renderDashboard(el) {
  const d = await api('GET', '/dashboard/summary');
  const isOwnerOrMgr = ['owner','manager'].includes(STATE.user.role);
  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card success">
        <div class="stat-label">Available Beds</div>
        <div class="stat-value">${d.occupancy?.available ?? 0}</div>
        <div class="stat-sub">of ${d.occupancy?.total ?? 0} total</div>
      </div>
      <div class="stat-card accent">
        <div class="stat-label">Occupied</div>
        <div class="stat-value">${d.occupancy?.occupied ?? 0}</div>
        <div class="stat-sub">Active residents: ${d.active_residents ?? 0}</div>
      </div>
      <div class="stat-card warning">
        <div class="stat-label">Cleaning</div>
        <div class="stat-value">${d.occupancy?.cleaning ?? 0}</div>
      </div>
      <div class="stat-card ${d.pending_refunds > 0 ? 'danger' : 'gray'}">
        <div class="stat-label">Pending Refunds</div>
        <div class="stat-value">${d.pending_refunds ?? 0}</div>
        ${d.pending_refunds_total_paise ? `<div class="stat-sub">${rupees(d.pending_refunds_total_paise)}</div>` : ''}
      </div>
      ${isOwnerOrMgr ? `
        <div class="stat-card success">
          <div class="stat-label">Today's Collection</div>
          <div class="stat-value" style="font-size:18px">${rupees(d.today_collection_paise)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Monthly Revenue</div>
          <div class="stat-value" style="font-size:18px">${rupees(d.monthly_revenue_paise)}</div>
          <div class="stat-sub">Expenses: ${rupees(d.monthly_expenses_paise)}</div>
        </div>
        <div class="stat-card ${(d.monthly_net_paise||0) >= 0 ? 'success' : 'danger'}">
          <div class="stat-label">Monthly Net</div>
          <div class="stat-value" style="font-size:18px">${rupees(d.monthly_net_paise)}</div>
        </div>
        <div class="stat-card ${d.overdue_residents > 0 ? 'danger' : ''}">
          <div class="stat-label">Overdue This Month</div>
          <div class="stat-value">${d.overdue_residents ?? 0}</div>
          <div class="stat-sub">residents</div>
        </div>
      ` : ''}
    </div>
    <div class="card">
      <div class="flex-between mb-12">
        <strong>Quick Actions</strong>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="navigate('checkin')">✅ Check In Resident</button>
        <button class="btn btn-outline" onclick="navigate('beds')">🛏 View Beds</button>
        <button class="btn btn-outline" onclick="navigate('payments')">💳 Record Payment</button>
        ${d.pending_refunds > 0 ? `<button class="btn btn-warning" onclick="navigate('payments')">⚠️ ${d.pending_refunds} Pending Approval(s)</button>` : ''}
      </div>
    </div>
  `;
}

// ── Beds ──────────────────────────────────────────────────────
async function renderBeds(el) {
  const beds = await api('GET', '/beds');
  const ha   = document.getElementById('header-actions');
  if (['owner','manager'].includes(STATE.user.role)) {
    ha.innerHTML = `<button class="btn btn-primary btn-sm" id="add-bed-btn">+ Add Bed</button>`;
    document.getElementById('add-bed-btn').onclick = () => showAddBedModal();
  }
  const statusCounts = {};
  beds.forEach(b => { statusCounts[b.status] = (statusCounts[b.status]||0)+1; });
  el.innerHTML = `
    <div class="stat-grid mb-20">
      ${Object.entries(statusCounts).map(([s,c]) => `
        <div class="stat-card"><div class="stat-label">${s}</div><div class="stat-value">${c}</div></div>
      `).join('')}
    </div>
    <div class="bed-grid">
      ${beds.map(b => `
        <div class="bed-card ${b.status}" onclick="showBedDetail('${b.id}')">
          <div class="bed-label">${b.bed_label}</div>
          <div class="bed-status">${b.room_number ? b.room_number+' · ' : ''}${b.status}</div>
          ${b.resident_name ? `<div class="bed-resident">${b.resident_name}</div>` : ''}
          ${b.monthly_rent_paise ? `<div class="bed-resident">${rupees(b.monthly_rent_paise)}/mo</div>` : (b.base_rate_paise ? `<div class="bed-resident" style="opacity:.6">${rupees(b.base_rate_paise)}/mo</div>` : '')}
        </div>
      `).join('')}
    </div>
  `;
}

async function showBedDetail(bedId) {
  const b = await api('GET', `/beds/${bedId}`);
  const isOwnerMgr = ['owner','manager'].includes(STATE.user.role);
  openModal(`Bed: ${b.bed_label}`, `
    <div class="field-row">
      <div><div class="stat-label">Status</div><span class="badge badge-${b.status==='available'?'success':b.status==='occupied'?'info':'warning'}">${b.status}</span></div>
      <div><div class="stat-label">Room</div><p>${b.room_number||'—'} ${b.floor_label||''}</p></div>
    </div>
    ${b.base_rate_paise ? `<div><div class="stat-label">Base Rate</div><p>${rupees(b.base_rate_paise)}/month</p></div>` : ''}
    ${b.resident_name ? `
      <hr class="divider"/>
      <div><strong>${b.resident_name}</strong> · ${b.resident_mobile||''}</div>
      <div class="text-muted">Check-in: ${fmtDate(b.check_in_date)} · Expected out: ${fmtDate(b.expected_checkout)}</div>
      <div>Rent: ${rupees(b.monthly_rent_paise)}/month</div>
      <div class="btn-group mt-12">
        <button class="btn btn-outline btn-sm" onclick="closeModal();showResidentDetail('${b.resident_id}')">View Details</button>
        <button class="btn btn-outline btn-sm" onclick="closeModal();showPaymentModal('${b.resident_id}','${esc(b.resident_name)}')">Record Payment</button>
        <button class="btn btn-danger btn-sm" onclick="closeModal();showCheckoutModal('${b.resident_id}','${esc(b.resident_name)}',${b.deposit_paise||0})">Check Out</button>
      </div>
    ` : ''}
    ${!b.resident_name && (b.status === 'available' || b.status === 'reserved') ? `
      <hr class="divider"/>
      <div class="btn-group">
        <button class="btn btn-primary btn-sm" onclick="closeModal();navigateCheckinForBed('${b.id}')">✅ Check In to this bed</button>
      </div>
    ` : ''}
    ${!b.resident_name && b.status !== 'occupied' ? `
      <hr class="divider"/>
      <div class="section-title">Change Status</div>
      <div class="btn-group">
        ${['available','cleaning'].filter(s=>s!==b.status).map(s =>
          `<button class="btn btn-outline btn-sm" onclick="changeBedStatus('${bedId}','${s}')">Set ${s}</button>`
        ).join('')}
      </div>
    ` : ''}
    ${isOwnerMgr ? `
      <hr class="divider"/>
      <div class="section-title">Set Bed Rate</div>
      <div class="field-row">
        <div class="field"><label>Monthly Rate (paise)</label><input id="br-rate" type="number" min="0" value="${b.base_rate_paise||0}" /></div>
        <div><button class="btn btn-outline btn-sm" style="margin-top:24px" onclick="saveBedRate('${bedId}')">Save Rate</button></div>
      </div>
    ` : ''}
  `);
}

function navigateCheckinForBed(bedId) {
  navigate('checkin');
  // Wait for the form to render, then pre-select the bed
  setTimeout(() => {
    const sel = document.getElementById('ci-bed');
    if (sel) { sel.value = bedId; sel.dispatchEvent(new Event('change')); }
  }, 300);
}

async function saveBedRate(bedId) {
  try {
    const rate = parseInt(document.getElementById('br-rate').value) || 0;
    await api('PATCH', `/beds/${bedId}/rate`, { base_rate_paise: rate });
    toast('Bed rate updated', 'success');
    closeModal(); renderPage('beds');
  } catch(ex) { toast(ex.message, 'error'); }
}

async function changeBedStatus(bedId, status) {
  try {
    await api('PATCH', `/beds/${bedId}/status`, { status });
    toast(`Bed set to ${status}`, 'success');
    closeModal();
    renderPage('beds');
  } catch(ex) { toast(ex.message, 'error'); }
}

async function showAddBedModal() {
  const floors = await api('GET', '/floors');
  const roomOptions = floors.flatMap(f => f.rooms.map(r =>
    `<option value="${r.id}">${f.label} › Room ${r.room_number}</option>`
  )).join('');
  openModal('Add Bed', `
    <div class="field"><label>Room</label><select id="ab-room">${roomOptions}</select></div>
    <div class="field-row">
      <div class="field"><label>Bed Label *</label><input id="ab-label" placeholder="e.g. 101-D" /></div>
      <div class="field"><label>Monthly Rate (paise)</label><input id="ab-rate" type="number" min="0" value="0" placeholder="500000" /></div>
    </div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" onclick="submitAddBed()">Add Bed</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitAddBed() {
  try {
    await api('POST', '/beds', {
      room_id: document.getElementById('ab-room').value,
      bed_label: document.getElementById('ab-label').value,
      base_rate_paise: parseInt(document.getElementById('ab-rate').value) || 0,
    });
    toast('Bed added', 'success'); closeModal(); renderPage('beds');
  } catch(ex) { toast(ex.message, 'error'); }
}

// ── Check In ─────────────────────────────────────────────────
async function renderCheckin(el) {
  // FIX: Load both available AND reserved beds (reserved = confirmed booking ready for check-in)
  const [avail, reserved] = await Promise.all([
    api('GET', '/beds?status=available'),
    api('GET', '/beds?status=reserved'),
  ]);
  const beds = [...avail, ...reserved];
  const bedOpts = beds.length
    ? beds.map(b => `<option value="${b.id}" data-rate="${b.base_rate_paise||0}">${b.bed_label} (${b.room_number||''})${b.status==='reserved'?' [RESERVED]':''}${b.base_rate_paise?` — ${rupees(b.base_rate_paise)}/mo`:''}</option>`).join('')
    : '<option value="">No available beds</option>';

  el.innerHTML = `
    <div class="card">
      <form id="checkin-form" onsubmit="return false">
        <div class="section-title">Personal Details</div>
        <div class="field-row">
          <div class="field"><label>Full Name *</label><input id="ci-name" required /></div>
          <div class="field"><label>Mobile *</label><input id="ci-mobile" type="tel" required /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Aadhaar Number</label><input id="ci-aadhaar" placeholder="XXXX XXXX XXXX" maxlength="14" /></div>
          <div class="field"><label>Aadhaar Linked Mobile</label><input id="ci-aadhaar-mobile" type="tel" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Coming From</label><input id="ci-from" /></div>
          <div class="field"><label>Purpose of Visit</label><input id="ci-purpose" /></div>
        </div>
        <div class="field">
          <label>Permanent Address</label>
          <textarea id="ci-address" rows="2"></textarea>
        </div>
        <div class="field-row">
          <div class="field"><label>Emergency Contact Name</label><input id="ci-ec-name" /></div>
          <div class="field"><label>Emergency Contact Mobile</label><input id="ci-ec-mobile" type="tel" /></div>
        </div>

        <div class="section-title">Booking Details</div>
        <div class="field-row">
          <div class="field"><label>Bed *</label><select id="ci-bed">${bedOpts}</select></div>
          <div class="field"><label>Rent Due Day</label><input id="ci-due-day" type="number" min="1" max="28" value="1" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Check-in Date *</label><input id="ci-checkin" type="date" value="${new Date().toISOString().substring(0,10)}" required /></div>
          <div class="field"><label>Expected Check-out *</label><input id="ci-checkout" type="date" required /></div>
        </div>

        <div class="section-title">Financial Details (in Paise)</div>
        <div class="field-note mb-12">Enter amounts in paise (₹1 = 100 paise). Example: ₹5,000 = 500000. Rent auto-fills from bed rate if set.</div>
        <div class="field-row">
          <div class="field"><label>Monthly Rent (paise) *</label><input id="ci-rent" type="number" min="0" required placeholder="500000" /></div>
          <div class="field"><label>Deposit (paise)</label><input id="ci-deposit" type="number" min="0" placeholder="1000000" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Advance Paid (paise)</label><input id="ci-advance" type="number" min="0" placeholder="0" /></div>
          <div class="field"><label>Payment Mode</label>
            <select id="ci-mode">
              <option value="cash">Cash</option><option value="upi">UPI</option>
              <option value="card">Card</option><option value="bank_transfer">Bank Transfer</option>
            </select>
          </div>
        </div>
        <div class="field"><label>Notes</label><textarea id="ci-notes" rows="2"></textarea></div>

        <div class="field" style="background:var(--primary-light);padding:12px;border-radius:var(--radius)">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="ci-consent" required />
            <span>I confirm the resident has given consent to collect and store their Aadhaar details (required under DPDP Act 2023)</span>
          </label>
        </div>

        <div id="ci-error" class="error-msg hidden"></div>
        <div class="btn-group mt-12">
          <button type="submit" id="ci-submit" class="btn btn-primary" onclick="submitCheckin()">✅ Complete Check-In</button>
          <button type="button" class="btn btn-outline" onclick="navigate('residents')">Cancel</button>
        </div>
      </form>
    </div>
  `;
  // Auto-fill rent from bed base rate when bed selection changes
  const bedSelect = document.getElementById('ci-bed');
  const rentInput = document.getElementById('ci-rent');
  if (bedSelect && rentInput) {
    function fillRate() {
      const opt = bedSelect.options[bedSelect.selectedIndex];
      const rate = parseInt(opt?.dataset?.rate || 0);
      if (rate > 0 && !rentInput.value) rentInput.value = rate;
    }
    bedSelect.addEventListener('change', () => { rentInput.value = ''; fillRate(); });
    fillRate(); // fill on initial load
  }
}

async function submitCheckin() {
  const err = document.getElementById('ci-error');
  err.classList.add('hidden');
  const btn = document.getElementById('ci-submit');
  btn.disabled = true;
  btn.textContent = 'Checking in…';
  try {
    const data = {
      full_name:              document.getElementById('ci-name').value.trim(),
      mobile:                 document.getElementById('ci-mobile').value.trim(),
      aadhaar_number:         document.getElementById('ci-aadhaar').value.replace(/\s/g,''),
      aadhaar_mobile:         document.getElementById('ci-aadhaar-mobile').value.trim(),
      coming_from:            document.getElementById('ci-from').value.trim(),
      purpose_of_visit:       document.getElementById('ci-purpose').value.trim(),
      permanent_address:      document.getElementById('ci-address').value.trim(),
      emergency_contact_name: document.getElementById('ci-ec-name').value.trim(),
      emergency_contact_mobile: document.getElementById('ci-ec-mobile').value.trim(),
      bed_id:                 document.getElementById('ci-bed').value,
      rent_due_day:           parseInt(document.getElementById('ci-due-day').value) || 1,
      check_in_date:          document.getElementById('ci-checkin').value,
      expected_checkout:      document.getElementById('ci-checkout').value,
      monthly_rent_paise:     parseInt(document.getElementById('ci-rent').value) || 0,
      deposit_paise:          parseInt(document.getElementById('ci-deposit').value) || 0,
      amount_paid_paise:      parseInt(document.getElementById('ci-advance').value) || 0,
      payment_mode:           document.getElementById('ci-mode').value,
      notes:                  document.getElementById('ci-notes').value.trim(),
      aadhaar_consent:        document.getElementById('ci-consent').checked,
    };
    const result = await api('POST', '/residents', data);
    toast(`${data.full_name} checked in successfully!`, 'success');
    navigate('residents');
  } catch(ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '✅ Complete Check-In';
  }
}

// ── Residents ─────────────────────────────────────────────────
async function renderResidents(el) {
  const ha = document.getElementById('header-actions');
  ha.innerHTML = `
    <input id="res-search" placeholder="Search name or mobile…" style="padding:6px 10px;border:1px solid var(--gray-200);border-radius:var(--radius);font-size:13px;width:200px" />
    <select id="res-status" style="padding:6px 10px;border:1px solid var(--gray-200);border-radius:var(--radius);font-size:13px">
      <option value="active">Active</option><option value="checked_out">Checked Out</option><option value="all">All</option>
    </select>
  `;

  async function load() {
    const search = document.getElementById('res-search')?.value || '';
    const status = document.getElementById('res-status')?.value || 'active';
    const residents = await api('GET', `/residents?status=${status}${search ? `&search=${encodeURIComponent(search)}` : ''}`);
    el.innerHTML = residents.length ? `
      <div class="card table-wrap">
        <table>
          <thead><tr>
            <th>Resident</th><th>Bed</th><th>Check-in</th><th>Due Out</th>
            <th>Rent/mo</th><th>Payment</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${residents.map(r => `
              <tr>
                <td>
                  <div class="td-name">${r.full_name}</div>
                  <div class="td-small">${r.mobile}</div>
                </td>
                <td>${r.bed_label||'—'}<div class="td-small">${r.room_number||''}</div></td>
                <td>${fmtDate(r.check_in_date)}</td>
                <td>${fmtDate(r.expected_checkout)}</td>
                <td>${rupees(r.monthly_rent_paise)}</td>
                <td><span class="badge badge-${r.payment_badge==='paid'?'success':r.payment_badge==='partial'?'warning':'danger'}">${r.payment_badge}</span></td>
                <td>
                  <button class="btn btn-outline btn-sm" onclick="showResidentDetail('${r.id}')">View</button>
                  ${r.status==='active' ? `<button class="btn btn-danger btn-sm" onclick="showCheckoutModal('${r.id}','${esc(r.full_name)}',${r.deposit_paise})">Check Out</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : `<div class="empty-state"><div class="empty-icon">👥</div><p>No residents found</p></div>`;
  }

  await load();
  document.getElementById('res-search').addEventListener('input', () => { clearTimeout(window._rsTimer); window._rsTimer = setTimeout(load, 350); });
  document.getElementById('res-status').addEventListener('change', load);
}

async function showResidentDetail(id) {
  const r = await api('GET', `/residents/${id}`);
  const ledger = r.payments || [];
  openModal(`${r.full_name}`, `
    <div class="field-row">
      <div><div class="stat-label">Mobile</div><p>${r.mobile}</p></div>
      <div><div class="stat-label">Bed</div><p>${r.bed_label||'—'} ${r.room_number||''}</p></div>
    </div>
    <div class="field-row">
      <div><div class="stat-label">Check-in</div><p>${fmtDate(r.check_in_date)}</p></div>
      <div><div class="stat-label">Expected Out</div><p>${fmtDate(r.expected_checkout)}</p></div>
    </div>
    <div class="field-row">
      <div><div class="stat-label">Rent/month</div><p>${rupees(r.monthly_rent_paise)}</p></div>
      <div><div class="stat-label">Deposit</div><p>${rupees(r.deposit_paise)}</p></div>
    </div>
    ${r.aadhaar_display ? `<div><div class="stat-label">Aadhaar</div><p>${r.aadhaar_display}</p></div>` : ''}
    <hr class="divider"/>
    <strong>Payment History</strong>
    ${ledger.length ? `
      <div class="table-wrap mt-12">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Mode</th><th>Status</th></tr></thead>
          <tbody>
            ${ledger.slice(0,10).map(p => `
              <tr>
                <td>${fmtDate(p.paid_at)}</td>
                <td>${p.type}</td>
                <td class="${p.direction==='credit'?'ledger-credit':'ledger-debit'}">${p.direction===  'credit'?'+':'-'}${rupees(p.amount_paise)}</td>
                <td>${p.payment_mode}</td>
                <td><span class="badge badge-${p.approval_status==='approved'||p.approval_status==='not_required'?'success':p.approval_status==='pending'?'warning':'danger'}">${p.approval_status}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<p class="text-muted mt-12">No payment records</p>'}
    <div class="btn-group mt-12">
      <button class="btn btn-outline btn-sm" onclick="closeModal();showPaymentModal('${r.id}','${esc(r.full_name)}')">Record Payment</button>
      ${r.status==='active'?`<button class="btn btn-danger btn-sm" onclick="closeModal();showCheckoutModal('${r.id}','${esc(r.full_name)}',${r.deposit_paise})">Check Out</button>`:''}
    </div>
  `, { wide: true });
}

function showCheckoutModal(id, name, depositPaise) {
  openModal(`Check Out: ${name}`, `
    <div class="field"><label>Checkout Date *</label><input id="co-date" type="date" value="${new Date().toISOString().substring(0,10)}" /></div>
    <div class="field"><label>Deposit Refund (paise)</label><input id="co-refund" type="number" min="0" value="${depositPaise||0}" /></div>
    <div class="field"><label>Extra Charges (paise)</label><input id="co-extra" type="number" min="0" value="0" /></div>
    <div class="field"><label>Extra Charges Note</label><input id="co-extra-note" placeholder="Damage, cleaning fee, etc." /></div>
    <div class="field"><label>Payment Mode</label>
      <select id="co-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank Transfer</option></select>
    </div>
    <div class="field"><label>Notes</label><textarea id="co-notes" rows="2"></textarea></div>
    <div id="co-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-danger" onclick="submitCheckout('${id}')">Confirm Check Out</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitCheckout(id) {
  const err = document.getElementById('co-error');
  err.classList.add('hidden');
  try {
    const res = await api('POST', `/residents/${id}/checkout`, {
      checkout_date:          document.getElementById('co-date').value,
      deposit_refund_paise:   parseInt(document.getElementById('co-refund').value) || 0,
      extra_charges_paise:    parseInt(document.getElementById('co-extra').value) || 0,
      extra_charges_note:     document.getElementById('co-extra-note').value,
      payment_mode:           document.getElementById('co-mode').value,
      notes:                  document.getElementById('co-notes').value,
    });
    if (res.refund_pending_approval) {
      toast('Checkout pending owner refund approval', 'warning', 5000);
    } else {
      toast('Checkout complete', 'success');
    }
    closeModal(); renderPage('residents');
  } catch(ex) {
    err.textContent = ex.message; err.classList.remove('hidden');
  }
}

// ── Payments ─────────────────────────────────────────────────
async function renderPayments(el) {
  const [residents, pending] = await Promise.all([
    api('GET', '/residents?status=active'),
    api('GET', '/payments/pending-approvals').catch(() => []),
  ]);

  const resOpts = residents.map(r =>
    `<option value="${r.id}">${r.full_name} — ${r.bed_label||''}</option>`
  ).join('');

  el.innerHTML = `
    ${pending.length ? `
      <div class="card mb-20" style="border-left:3px solid var(--warning)">
        <strong>⚠️ ${pending.length} Pending Approval(s)</strong>
        <div class="table-wrap mt-12">
          <table>
            <thead><tr><th>Resident</th><th>Type</th><th>Amount</th><th>Recorded</th><th>Actions</th></tr></thead>
            <tbody>
              ${pending.map(p => `
                <tr>
                  <td>${p.resident_name}</td><td>${p.type}</td>
                  <td>${rupees(p.amount_paise)}</td><td>${fmtDate(p.created_at)}</td>
                  <td>
                    <button class="btn btn-success btn-sm" onclick="approvePayment('${p.id}','approved')">Approve</button>
                    <button class="btn btn-danger btn-sm" onclick="approvePayment('${p.id}','rejected')">Reject</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
    <div class="card">
      <strong>Record Payment</strong>
      <div class="field mt-12"><label>Resident *</label><select id="pay-resident">${resOpts}</select></div>
      <div class="field-row">
        <div class="field"><label>Type</label>
          <select id="pay-type">
            <option value="rent">Rent</option><option value="deposit">Deposit</option>
            <option value="advance">Advance</option><option value="extra_charge">Extra Charge</option>
          </select>
        </div>
        <div class="field"><label>Amount (paise) *</label><input id="pay-amount" type="number" min="1" placeholder="500000" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Payment Mode</label>
          <select id="pay-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank Transfer</option></select>
        </div>
        <div class="field"><label>Billing Month</label><input id="pay-month" type="month" value="${new Date().toISOString().substring(0,7)}" /></div>
      </div>
      <div class="field"><label>Notes</label><input id="pay-notes" /></div>
      <div id="pay-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitPayment()">💳 Record Payment</button>
    </div>
  `;
}

// FIX: showPaymentModal was called from resident detail but never defined
function showPaymentModal(residentId, residentName) {
  openModal(`Record Payment: ${residentName}`, `
    <input type="hidden" id="pm-resident" value="${residentId}" />
    <div class="field-row">
      <div class="field"><label>Type</label>
        <select id="pm-type"><option value="rent">Rent</option><option value="advance">Advance</option><option value="deposit">Deposit</option><option value="extra_charge">Extra Charge</option></select>
      </div>
      <div class="field"><label>Amount (paise) *</label><input id="pm-amount" type="number" min="1" placeholder="500000" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Payment Mode</label>
        <select id="pm-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank Transfer</option></select>
      </div>
      <div class="field"><label>Billing Month</label><input id="pm-month" type="month" value="${new Date().toISOString().substring(0,7)}" /></div>
    </div>
    <div class="field"><label>Notes</label><input id="pm-notes" /></div>
    <div id="pm-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" onclick="submitModalPayment()">💳 Record Payment</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitModalPayment() {
  const err = document.getElementById('pm-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/payments', {
      resident_id:   document.getElementById('pm-resident').value,
      type:          document.getElementById('pm-type').value,
      amount_paise:  parseInt(document.getElementById('pm-amount').value),
      payment_mode:  document.getElementById('pm-mode').value,
      billing_month: document.getElementById('pm-month').value,
      notes:         document.getElementById('pm-notes').value,
    });
    toast('Payment recorded', 'success');
    closeModal();
    refreshCurrentPage();
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function submitPayment() {
  const err = document.getElementById('pay-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/payments', {
      resident_id:   document.getElementById('pay-resident').value,
      type:          document.getElementById('pay-type').value,
      amount_paise:  parseInt(document.getElementById('pay-amount').value),
      payment_mode:  document.getElementById('pay-mode').value,
      billing_month: document.getElementById('pay-month').value,
      notes:         document.getElementById('pay-notes').value,
    });
    toast('Payment recorded and receipt generated', 'success');
    renderPage('payments');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function approvePayment(id, decision) {
  try {
    await api('POST', `/payments/${id}/approve`, { decision });
    toast(`Payment ${decision}`, decision === 'approved' ? 'success' : 'warning');
    renderPage('payments');
  } catch(ex) { toast(ex.message, 'error'); }
}

// ── Add-ons ───────────────────────────────────────────────────
async function renderAddons(el) {
  const residents = await api('GET', '/residents?status=active');
  const catalog   = await api('GET', '/addons/catalog').catch(() => []);
  const resOpts   = residents.map(r => `<option value="${r.id}">${r.full_name} — ${r.bed_label||''}</option>`).join('');
  const catOpts   = catalog.map(c => `<option value="${c.id}" data-price="${c.default_price_paise}">${c.name} (${rupees(c.default_price_paise)})</option>`).join('');

  el.innerHTML = `
    <div class="card">
      <strong>Add Charge</strong>
      <div class="field mt-12"><label>Resident *</label><select id="ao-resident">${resOpts}</select></div>
      <div class="field"><label>Catalog Item (optional)</label>
        <select id="ao-catalog" onchange="document.getElementById('ao-amount').value=this.options[this.selectedIndex]?.dataset?.price||''">
          <option value="">— Custom Entry —</option>${catOpts}
        </select>
      </div>
      <div class="field"><label>Name / Description *</label><input id="ao-name" placeholder="Leave blank to use catalog item name" /></div>
      <div class="field-row">
        <div class="field"><label>Amount (paise) *</label><input id="ao-amount" type="number" min="1" /></div>
        <div class="field"><label>Billing Mode</label>
          <select id="ao-billing"><option value="immediate">Immediate</option><option value="monthly_bill">Next Bill</option></select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Payment Mode</label>
          <select id="ao-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select>
        </div>
        <div class="field"><label>Reason</label><input id="ao-reason" /></div>
      </div>
      <div id="ao-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitAddon()">Add Charge</button>
    </div>
  `;
}

async function submitAddon() {
  const err = document.getElementById('ao-error');
  err.classList.add('hidden');
  const residentId = document.getElementById('ao-resident').value;
  try {
    await api('POST', `/residents/${residentId}/addons`, {
      catalog_item_id: document.getElementById('ao-catalog').value || undefined,
      name:            document.getElementById('ao-name').value.trim() || undefined,
      amount_paise:    parseInt(document.getElementById('ao-amount').value),
      billing_mode:    document.getElementById('ao-billing').value,
      payment_mode:    document.getElementById('ao-mode').value,
      custom_reason:   document.getElementById('ao-reason').value.trim(),
    });
    toast('Add-on charge recorded', 'success'); renderPage('addons');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Bookings ──────────────────────────────────────────────────
async function renderBookings(el) {
  const [bookings, beds] = await Promise.all([
    api('GET', '/bookings'),
    api('GET', '/beds?status=available'),
  ]);
  const bedOpts = beds.map(b => `<option value="${b.id}">${b.bed_label} (${b.room_number||''})</option>`).join('');

  el.innerHTML = `
    <div class="card mb-20">
      <strong>New Booking (Bed Lock)</strong>
      <div class="field-row mt-12">
        <div class="field"><label>Bed *</label><select id="bk-bed">${bedOpts||'<option value="">No available beds</option>'}</select></div>
        <div class="field"><label>Prospect Name *</label><input id="bk-name" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Prospect Phone *</label><input id="bk-phone" type="tel" /></div>
        <div class="field"><label>Advance Deposit (paise)</label><input id="bk-deposit" type="number" min="0" value="0" /></div>
      </div>
      <div id="bk-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitBooking()">🔒 Lock Bed</button>
    </div>
    <div class="card">
      <strong>Active Bookings</strong>
      ${bookings.length ? `
        <div class="table-wrap mt-12">
          <table>
            <thead><tr><th>Prospect</th><th>Bed</th><th>Advance</th><th>Expires</th><th>Actions</th></tr></thead>
            <tbody>
              ${bookings.map(b => `
                <tr>
                  <td><div class="td-name">${b.prospect_name}</div><div class="td-small">${b.prospect_phone}</div></td>
                  <td>${b.bed_label||''} ${b.room_number||''}</td>
                  <td>${rupees(b.advance_deposit_paise)}</td>
                  <td>${fmtDate(b.lock_expires_at)}</td>
                  <td>
                    <button class="btn btn-success btn-sm" onclick="confirmBooking('${b.id}')">Confirm</button>
                    <button class="btn btn-danger btn-sm" onclick="cancelBooking('${b.id}')">Cancel</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<p class="text-muted mt-12">No active bookings</p>'}
    </div>
  `;
}

async function submitBooking() {
  const err = document.getElementById('bk-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/bookings', {
      bed_id:                document.getElementById('bk-bed').value,
      prospect_name:         document.getElementById('bk-name').value.trim(),
      prospect_phone:        document.getElementById('bk-phone').value.trim(),
      advance_deposit_paise: parseInt(document.getElementById('bk-deposit').value) || 0,
    });
    toast('Bed locked for 24 hours', 'success'); renderPage('bookings');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function confirmBooking(id) {
  try { await api('POST', `/bookings/${id}/confirm`); toast('Booking confirmed', 'success'); renderPage('bookings'); }
  catch(ex) { toast(ex.message, 'error'); }
}
async function cancelBooking(id) {
  try { await api('POST', `/bookings/${id}/cancel`); toast('Booking cancelled, bed released', 'warning'); renderPage('bookings'); }
  catch(ex) { toast(ex.message, 'error'); }
}

// ── Cash Reconciliation ───────────────────────────────────────
function renderReconcile(el) {
  el.innerHTML = `
    <div class="card">
      <strong>Close Cash Drawer</strong>
      <p class="text-muted mt-12" style="font-size:13px">Enter the physical cash count. The system will compare against recorded cash payments for the day.</p>
      <div class="field-row mt-12">
        <div class="field"><label>Date *</label><input id="rc-date" type="date" value="${new Date().toISOString().substring(0,10)}" /></div>
        <div class="field"><label>Drawer Amount (paise) *</label><input id="rc-amount" type="number" min="0" placeholder="Enter physical cash count in paise" /></div>
      </div>
      <div id="rc-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitReconcile()">Submit Cash Close</button>
    </div>
  `;
}

async function submitReconcile() {
  const err = document.getElementById('rc-error');
  err.classList.add('hidden');
  try {
    const res = await api('POST', '/reconciliation/cash', {
      date: document.getElementById('rc-date').value,
      drawer_amount_paise: parseInt(document.getElementById('rc-amount').value),
    });
    const msg = res.is_discrepancy
      ? `⚠️ Discrepancy of ${rupees(Math.abs(res.delta_paise))} detected! Owner notified.`
      : `Cash balanced ✅ (${rupees(res.drawer_amount_paise)})`;
    toast(msg, res.is_discrepancy ? 'warning' : 'success', 6000);
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Expenses ─────────────────────────────────────────────────
async function renderExpenses(el) {
  const expenses = await api('GET', `/expenses?from=${new Date().toISOString().substring(0,7)}-01`);
  const total    = expenses.reduce((s, e) => s + e.amount_paise, 0);
  el.innerHTML = `
    <div class="card mb-20">
      <strong>Add Expense</strong>
      <div class="field-row mt-12">
        <div class="field"><label>Category *</label>
          <select id="ex-cat">
            <option value="utilities">Utilities</option><option value="maintenance">Maintenance</option>
            <option value="salary">Salary</option><option value="cleaning">Cleaning</option>
            <option value="grocery">Grocery</option><option value="other">Other</option>
          </select>
        </div>
        <div class="field"><label>Amount (paise) *</label><input id="ex-amount" type="number" min="1" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Date *</label><input id="ex-date" type="date" value="${new Date().toISOString().substring(0,10)}" /></div>
        <div class="field"><label>Payment Mode</label>
          <select id="ex-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select>
        </div>
      </div>
      <div class="field"><label>Description</label><input id="ex-desc" /></div>
      <div id="ex-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitExpense()">Add Expense</button>
    </div>
    <div class="card">
      <div class="flex-between mb-12">
        <strong>This Month's Expenses</strong>
        <span class="fw-bold text-danger">${rupees(total)} total</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Mode</th>${STATE.user.role==='owner'?'<th>Actions</th>':''}</tr></thead>
          <tbody>
            ${expenses.map(e => `
              <tr>
                <td>${fmtDate(e.expense_date)}</td><td>${e.category}</td>
                <td>${e.description||'—'}</td><td class="text-danger">${rupees(e.amount_paise)}</td>
                <td>${e.payment_mode}</td>
                ${STATE.user.role==='owner'?`<td><button class="btn btn-danger btn-sm" onclick="deleteExpense('${e.id}')">Delete</button></td>`:''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function submitExpense() {
  const err = document.getElementById('ex-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/expenses', {
      category:     document.getElementById('ex-cat').value,
      amount_paise: parseInt(document.getElementById('ex-amount').value),
      expense_date: document.getElementById('ex-date').value,
      payment_mode: document.getElementById('ex-mode').value,
      description:  document.getElementById('ex-desc').value.trim(),
    });
    toast('Expense recorded', 'success'); renderPage('expenses');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense? This cannot be undone.')) return;
  try {
    await api('DELETE', `/expenses/${id}`);
    toast('Expense deleted', 'warning');
    renderPage('expenses');
  } catch(ex) { toast(ex.message, 'error'); }
}

// ── Reports ───────────────────────────────────────────────────
async function renderReports(el) {
  const from = `${new Date().toISOString().substring(0,7)}-01`;
  const to   = new Date().toISOString().substring(0,10);
  const data = await api('GET', `/reports/summary?from=${from}&to=${to}`);
  const isOwner = STATE.user.role === 'owner';

  el.innerHTML = `
    <div class="stat-grid mb-20">
      <div class="stat-card success"><div class="stat-label">Revenue</div><div class="stat-value" style="font-size:18px">${rupees(data.total_revenue_paise)}</div></div>
      <div class="stat-card danger"><div class="stat-label">Expenses</div><div class="stat-value" style="font-size:18px">${rupees(data.total_expenses_paise)}</div></div>
      <div class="stat-card ${data.net_paise>=0?'success':'danger'}"><div class="stat-label">Net</div><div class="stat-value" style="font-size:18px">${rupees(data.net_paise)}</div></div>
    </div>
    ${isOwner ? `
      <div class="card mb-20">
        <strong>Export Report</strong>
        <div class="btn-group mt-12">
          <button class="btn btn-outline" onclick="downloadReport('xlsx','${from}','${to}')">📊 Excel</button>
          <button class="btn btn-outline" onclick="downloadReport('csv','${from}','${to}')">📄 CSV</button>
          <button class="btn btn-outline" onclick="downloadReport('pdf','${from}','${to}')">📋 PDF</button>
        </div>
      </div>
    ` : ''}
    <div class="card">
      <strong>Recent Payments</strong>
      <div class="table-wrap mt-12">
        <table>
          <thead><tr><th>Date</th><th>Resident</th><th>Type</th><th>Amount</th><th>Mode</th></tr></thead>
          <tbody>
            ${data.payments.slice(0,20).map(p => `
              <tr>
                <td>${fmtDate(p.paid_at)}</td><td>${p.resident_name}</td>
                <td>${p.type}</td><td class="ledger-credit">${rupees(p.amount_paise)}</td>
                <td>${p.payment_mode}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// FIX: Download export with auth token (bare <a> tags don't send Bearer token)
async function downloadReport(format, from, to) {
  try {
    const res = await fetch(`/api/v1/reports/export?format=${format}&from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${STATE.token}` },
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dormbook-report-${from}-to-${to}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Report downloaded', 'success');
  } catch(ex) { toast(ex.message, 'error'); }
}

// ── Property Settings (owner only) ────────────────────────────
async function renderSettings(el) {
  const prop = await api('GET', '/dashboard/summary').catch(() => null);
  // Fetch current property data by using a lightweight call
  let settings;
  try {
    // The settings are returned when we PATCH, but for reading we need the current values
    // We'll fetch via a dummy patch that changes nothing, or show the form with current known values
    settings = await api('PATCH', '/properties/settings', {});
  } catch(ex) {
    el.innerHTML = `<div class="error-msg">Could not load settings: ${ex.message}</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">
      <strong>Property Settings</strong>
      <div class="field mt-12"><label>Property Name</label><input id="ps-name" value="${settings.name||''}" /></div>
      <div class="field"><label>WhatsApp Number (with country code)</label><input id="ps-wa" value="${settings.whatsapp_number||''}" placeholder="919999900001" /></div>
      <div class="field-row">
        <div class="field"><label>Cleaning Timeout (minutes)</label><input id="ps-clean" type="number" min="0" value="${settings.cleaning_timeout_minutes||120}" /></div>
        <div class="field"><label>Refund Approval Threshold (paise)</label><input id="ps-refund" type="number" min="0" value="${settings.refund_approval_threshold_paise||0}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Booking Lock (hours)</label><input id="ps-lock" type="number" min="1" value="${settings.booking_lock_hours||24}" /></div>
        <div class="field"><label>Cash Tolerance (paise)</label><input id="ps-cash" type="number" min="0" value="${settings.cash_reconciliation_tolerance_paise||0}" /></div>
      </div>
      <div id="ps-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitSettings()">Save Settings</button>
    </div>
  `;
}

async function submitSettings() {
  const err = document.getElementById('ps-error');
  err.classList.add('hidden');
  try {
    await api('PATCH', '/properties/settings', {
      name:                              document.getElementById('ps-name').value.trim() || undefined,
      whatsapp_number:                   document.getElementById('ps-wa').value.trim() || undefined,
      cleaning_timeout_minutes:          parseInt(document.getElementById('ps-clean').value),
      refund_approval_threshold_paise:   parseInt(document.getElementById('ps-refund').value),
      booking_lock_hours:                parseInt(document.getElementById('ps-lock').value),
      cash_reconciliation_tolerance_paise: parseInt(document.getElementById('ps-cash').value),
    });
    toast('Settings saved', 'success');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Staff ─────────────────────────────────────────────────────
async function renderStaff(el) {
  const staff = await api('GET', '/staff');
  const ha    = document.getElementById('header-actions');
  if (STATE.user.role === 'owner') {
    ha.innerHTML = `<button class="btn btn-primary btn-sm" onclick="showAddStaffModal()">+ Add Staff</button>`;
  }
  el.innerHTML = `
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Mobile</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${staff.map(s => `
            <tr>
              <td><div class="td-name">${s.name}</div><div class="td-small">${s.email||''}</div></td>
              <td>${s.mobile}</td>
              <td><span class="role-chip role-${s.role}">${s.role}</span></td>
              <td><span class="badge ${s.is_active?'badge-success':'badge-gray'}">${s.is_active?'Active':'Inactive'}</span></td>
              <td>
                ${STATE.user.role==='owner' && s.role!=='owner' ? `
                  <button class="btn btn-outline btn-sm" onclick="toggleStaff('${s.id}',${s.is_active})">
                    ${s.is_active?'Deactivate':'Reactivate'}
                  </button>
                ` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function toggleStaff(id, isActive) {
  try {
    if (isActive) {
      await api('DELETE', `/staff/${id}`);
      toast('Staff member deactivated', 'warning');
    } else {
      await api('PATCH', `/staff/${id}`, { is_active: true });
      toast('Staff member reactivated', 'success');
    }
    renderPage('staff');
  } catch(ex) { toast(ex.message, 'error'); }
}

function showAddStaffModal() {
  openModal('Add Staff Member', `
    <div class="field"><label>Name *</label><input id="sf-name" /></div>
    <div class="field-row">
      <div class="field"><label>Mobile *</label><input id="sf-mobile" type="tel" /></div>
      <div class="field"><label>Email</label><input id="sf-email" type="email" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Role *</label>
        <select id="sf-role"><option value="reception">Reception</option><option value="manager">Manager</option></select>
      </div>
      <div class="field"><label>Password *</label><input id="sf-password" type="password" placeholder="Min 8 characters" /></div>
    </div>
    <div id="sf-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" onclick="submitStaff()">Add Staff</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitStaff() {
  const err = document.getElementById('sf-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/staff', {
      name:     document.getElementById('sf-name').value.trim(),
      mobile:   document.getElementById('sf-mobile').value.trim(),
      email:    document.getElementById('sf-email').value.trim() || undefined,
      role:     document.getElementById('sf-role').value,
      password: document.getElementById('sf-password').value,
    });
    toast('Staff member added', 'success'); closeModal(); renderPage('staff');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Feedback ──────────────────────────────────────────────────
async function renderFeedback(el) {
  const data = await api('GET', '/feedback');
  el.innerHTML = `
    <div class="stat-grid mb-20">
      <div class="stat-card success"><div class="stat-label">Good</div><div class="stat-value">${data.summary?.good||0}</div></div>
      <div class="stat-card warning"><div class="stat-label">Average</div><div class="stat-value">${data.summary?.average||0}</div></div>
      <div class="stat-card danger"><div class="stat-label">Needs Help</div><div class="stat-value">${data.summary?.needs_help||0}</div></div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Resident</th><th>Rating</th><th>Flagged</th><th>Date</th><th>Actions</th></tr></thead>
        <tbody>
          ${(data.feedback||[]).map(f => `
            <tr>
              <td><div class="td-name">${f.resident_name}</div></td>
              <td><span class="badge ${f.rating==='good'?'badge-success':f.rating==='average'?'badge-warning':'badge-danger'}">${f.rating}</span></td>
              <td>${f.is_flagged?'⚠️ Flagged':'—'}</td>
              <td>${fmtDate(f.created_at)}</td>
              <td>${f.is_flagged&&!f.resolved_at?`<button class="btn btn-outline btn-sm" onclick="resolveFeedback('${f.id}')">Resolve</button>`:'—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function resolveFeedback(id) {
  try { await api('PATCH', `/feedback/${id}/resolve`, { notes: 'Resolved via dashboard' }); toast('Feedback resolved', 'success'); renderPage('feedback'); }
  catch(ex) { toast(ex.message, 'error'); }
}

// ── Add-on Catalog ────────────────────────────────────────────
async function renderCatalog(el) {
  const items = await api('GET', '/addons/catalog');
  el.innerHTML = `
    <div class="card mb-20">
      <strong>Add Catalog Item</strong>
      <div class="field-row mt-12">
        <div class="field"><label>Name *</label><input id="cat-name" /></div>
        <div class="field"><label>Category *</label><input id="cat-cat" placeholder="utilities, amenities, etc." /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Default Price (paise)</label><input id="cat-price" type="number" min="0" value="0" /></div>
        <div class="field"><label>Assignable Item?</label>
          <select id="cat-assign"><option value="0">No</option><option value="1">Yes (tracked item)</option></select>
        </div>
      </div>
      <div id="cat-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitCatalogItem()">Add to Catalog</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Assignable</th><th>Status</th></tr></thead>
        <tbody>
          ${items.map(i => `
            <tr>
              <td class="td-name">${i.name}</td><td>${i.category}</td>
              <td>${rupees(i.default_price_paise)}</td>
              <td>${i.is_assignable?'Yes':'No'}</td>
              <td><span class="badge ${i.is_active?'badge-success':'badge-gray'}">${i.is_active?'Active':'Inactive'}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function submitCatalogItem() {
  const err = document.getElementById('cat-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/addons/catalog', {
      name:                 document.getElementById('cat-name').value.trim(),
      category:             document.getElementById('cat-cat').value.trim(),
      default_price_paise:  parseInt(document.getElementById('cat-price').value) || 0,
      is_assignable:        parseInt(document.getElementById('cat-assign').value),
    });
    toast('Catalog item added', 'success'); renderPage('catalog');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Audit Log ─────────────────────────────────────────────────
async function renderAudit(el) {
  const rows = await api('GET', '/audit');
  el.innerHTML = `
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Amount</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><div class="td-small">${new Date(r.created_at).toLocaleString('en-IN')}</div></td>
              <td>${r.actor_name}</td>
              <td><code style="font-size:11px;background:var(--gray-100);padding:2px 6px;border-radius:4px">${r.action}</code></td>
              <td>${r.entity_type}<div class="td-small">${r.entity_id.substring(0,8)}…</div></td>
              <td>${r.amount_paise ? rupees(r.amount_paise) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
