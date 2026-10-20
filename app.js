// Auto-detect URL GAS saat dijalankan dari Google Apps Script (HtmlService)
// Jika dibuka dari GAS (script.google.com), gunakan URL halaman itu sendiri → same-origin
// Jika dibuka dari localhost/file, gunakan URL fallback hardcoded
const FALLBACK_GAS_URL = "https://script.google.com/macros/s/AKfycbw0kao-EtoKUzUlb3TFmCoNiV8h8FdsoSyaQ5adIP88CdaqwqpXeYMF7xuGE_CiLELnuw/exec";
const IS_RUNNING_ON_GAS = window.location.href.includes('script.google.com') || window.location.href.includes('googleusercontent.com');
const DEFAULT_GAS_URL = IS_RUNNING_ON_GAS
  ? window.location.href.split('?')[0]  // URL halaman itu sendiri = GAS endpoint
  : FALLBACK_GAS_URL;

let storedGasUrl = localStorage.getItem('bymoment_gas_url');
// Hapus URL tersimpan jika sudah tidak sesuai (misalnya deployment lama)
if (storedGasUrl && IS_RUNNING_ON_GAS) {
  // Saat dijalankan dari GAS, selalu pakai URL otomatis (bukan localStorage)
  storedGasUrl = null;
}

/* ── 1. GLOBAL CONSTANTS & CONFIG ───────────────────────────── */
const PRICE_SESI = 25000;      // 1 Sesi Foto = Rp 25.000
const PRICE_EXTRA_PRINT = 10000; // Extra Print = Rp 10.000 / lembar
const DURATION_PER_SESI_MINUTES = 5; // 1 Sesi = 5 menit (300 detik)

/* ── 2. APPLICATION STATE ────────────────────────────────────── */
const STATE = {
  gasUrl: storedGasUrl || DEFAULT_GAS_URL,
  currentUser: JSON.parse(localStorage.getItem('bymoment_user') || 'null'),
  paperStock: Number(localStorage.getItem('bymoment_paper_stock')) || 0,
  promos: JSON.parse(localStorage.getItem('bymoment_promos') || '[]'),

  // Form Input State
  sesi: 1,
  extraPrint: 0,
  selectedPromo: null,

  // Active Queues & Sessions
  queue: JSON.parse(localStorage.getItem('bymoment_active_queues') || '[]'),

  // Temporary Modal State
  pendingMethod: 'Cash',
  lastTransaction: null
};

/**
 * Helper Safe Fetch untuk Google Apps Script.
 * Saat app dijalankan dari GAS (HtmlService), semua request sudah same-origin
 * sehingga fetch() biasa bekerja sempurna tanpa masalah CORS.
 */
async function safeGasFetch(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, redirect: 'follow' });

    if (!response.ok) {
      const status = response.status;
      let errMsg = `Server merespon error HTTP ${status}.`;
      if (status === 404) {
        errMsg = `URL GAS tidak ditemukan (404). Periksa URL di menu Konfigurasi.`;
      }
      return { success: false, error: errMsg, status: status };
    }

    const text = await response.text();
    const trimmed = (text || '').trim();

    if (trimmed.startsWith('<')) {
      let htmlMsg = 'GAS mengembalikan HTML (bukan JSON).';
      if (trimmed.includes('accounts.google.com') || trimmed.includes('Sign in')) {
        htmlMsg = 'Akses ditolak: GAS meminta login. Pastikan deployment "Who has access: Anyone".';
      } else if (trimmed.includes('Not Found') || trimmed.includes('404')) {
        htmlMsg = 'Web App GAS tidak ditemukan (404). Pastikan sudah di-deploy.';
      }
      return { success: false, error: htmlMsg, isHtml: true };
    }

    try {
      return JSON.parse(trimmed);
    } catch (parseErr) {
      return { success: false, error: 'Format JSON dari server tidak valid.' };
    }

  } catch (networkErr) {
    console.error('Network Error safeGasFetch:', networkErr);
    return { success: false, error: 'Koneksi gagal. Periksa koneksi internet dan URL GAS.' };
  }
}

/* ── 3. HELPER UTILS ─────────────────────────────────────────── */
function formatRp(num) {
  return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
}

function formatTimeSeconds(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function generateTransactionId() {
  const now = new Date();
  const datePart = now.getFullYear().toString().slice(-2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `TRX-${datePart}-${randomPart}`;
}

function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast-box';

  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };

  toast.innerHTML = `<span>${icons[type] || '💡'}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'all 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/* ── 4. INITIALIZATION & CLOCK ───────────────────────────────── */
function initClock() {
  function update() {
    const now = new Date();
    const te = document.getElementById('live-time');
    const de = document.getElementById('live-date');
    if (te) te.textContent = now.toLocaleTimeString('id-ID', { hour12: false });
    if (de) de.textContent = now.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  setInterval(update, 1000);
  update();
}

window.addEventListener('DOMContentLoaded', () => {
  initClock();

  // Cek apakah ada session aktif
  if (STATE.currentUser) {
    showDashboardView();
    // Sinkronisasi data promo & stok kertas terkini dari GAS
    fetchDashboardData(true);
  } else {
    showLoginView();
  }

  // Resume timer untuk queue yang sedang berjalan
  resumeActiveTimers();

  // Auto-sync stok kertas dan promo setiap 60 detik jika sedang aktif
  setInterval(() => {
    if (STATE.currentUser && !document.hidden) {
      fetchDashboardData(true);
    }
  }, 60000);
});

/* ── 5. AUTHENTICATION & LOGIN LOGIC ─────────────────────────── */
const togglePwBtn = document.getElementById('toggle-pw');
if (togglePwBtn) {
  togglePwBtn.addEventListener('click', () => {
    const input = document.getElementById('login-password');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  });
}

const loginForm = document.getElementById('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameInput = document.getElementById('login-username').value.trim();
    const passwordInput = document.getElementById('login-password').value.trim();
    const btn = document.getElementById('login-btn');
    const btnTxt = document.getElementById('login-btn-text');
    const spinner = document.getElementById('login-spinner');
    const errBox = document.getElementById('login-error');
    const errMsg = document.getElementById('login-error-msg');

    btnTxt.textContent = 'Memverifikasi...';
    spinner.classList.remove('hidden');
    btn.disabled = true;
    errBox.classList.add('hidden');

    try {
      const gasUrl = (STATE.gasUrl || DEFAULT_GAS_URL).trim();
      const sep = gasUrl.includes('?') ? '&' : '?';
      const targetUrl = `${gasUrl}${sep}action=login&username=${encodeURIComponent(usernameInput)}&password=${encodeURIComponent(passwordInput)}&_ts=${Date.now()}`;

      const result = await safeGasFetch(targetUrl, {
        method: 'GET',
        redirect: 'follow'
      });

      if (result && result.success === true) {
        // 1. Simpan data user yang berhasil login
        STATE.currentUser = result.user || { username: usernameInput, nama: usernameInput };
        localStorage.setItem('bymoment_user', JSON.stringify(STATE.currentUser));

        // 2. Tangkap data promos langsung dari response JSON login & simpan
        if (Array.isArray(result.promos)) {
          STATE.promos = result.promos;
          localStorage.setItem('bymoment_promos', JSON.stringify(result.promos));
          renderPromoDropdown();
        }

        // 3. Tangkap data stok kertas fisik langsung dari response JSON login & simpan
        if (typeof result.stok === 'number') {
          STATE.paperStock = result.stok;
          localStorage.setItem('bymoment_paper_stock', result.stok);
          updatePaperStockDisplay(result.stok);
        }

        showToast(`Selamat datang, ${STATE.currentUser.nama || STATE.currentUser.username}!`, 'success');
        showDashboardView();
      } else {
        errMsg.textContent = (result && result.error) ? result.error : 'Username atau password salah!';
        errBox.classList.remove('hidden');
      }
    } catch (err) {
      console.error('Login error:', err);
      errMsg.textContent = 'Gagal menghubungi Google Apps Script. Periksa koneksi internet atau URL GAS!';
      errBox.classList.remove('hidden');
    } finally {
      btnTxt.textContent = 'Masuk ke Kasir POS';
      spinner.classList.add('hidden');
      btn.disabled = false;
    }
  });
}

function showDashboardView() {
  const loginPage = document.getElementById('login-page');
  const dashPage = document.getElementById('dashboard-page');
  if (loginPage) loginPage.classList.add('hidden');
  if (dashPage) dashPage.classList.remove('hidden');

  const user = STATE.currentUser || { username: 'admin', nama: 'Admin' };
  const cName = document.getElementById('cashier-name');
  const cUser = document.getElementById('cashier-user');
  if (cName) cName.textContent = user.nama || user.username;
  if (cUser) cUser.textContent = '@' + user.username;

  // Render stok kertas & dropdown promo yang tersimpan
  updatePaperStockDisplay(STATE.paperStock);
  renderPromoDropdown();

  calculateAndRenderOrder();
  renderQueueList();
}

function showLoginView() {
  const dashPage = document.getElementById('dashboard-page');
  const loginPage = document.getElementById('login-page');
  if (dashPage) dashPage.classList.add('hidden');
  if (loginPage) loginPage.classList.remove('hidden');
}

function handleLogout() {
  if (confirm('Yakin ingin logout dari sistem Kasir?')) {
    localStorage.removeItem('bymoment_user');
    STATE.currentUser = null;
    showLoginView();
    showToast('Berhasil logout!', 'info');
  }
}

/* ── 6. PROMO & STOCK SYNC (fetchDashboardData) ─────────────── */
/**
 * Mengambil stok kertas dan promo aktif dari endpoint mandiri:
 * - GET ?action=getStok   -> { success: true, stok: ... }
 * - GET ?action=getPromos  -> { success: true, promos: [...] }
 */
async function fetchDashboardData(silent = false) {
  try {
    const gasUrl = (STATE.gasUrl || DEFAULT_GAS_URL).trim();
    if (!gasUrl) return;

    const sep = gasUrl.includes('?') ? '&' : '?';
    const urlStok = `${gasUrl}${sep}action=getStok&_ts=${Date.now()}`;
    const urlPromo = `${gasUrl}${sep}action=getPromos&_ts=${Date.now()}`;

    const [dataStok, dataPromo] = await Promise.all([
      safeGasFetch(urlStok, { redirect: 'follow' }),
      safeGasFetch(urlPromo, { redirect: 'follow' })
    ]);

    let hasError = false;

    // 1. Update Stok Kertas Fisik Murni dari GAS
    if (dataStok && dataStok.success === true && typeof dataStok.stok === 'number') {
      STATE.paperStock = dataStok.stok;
      localStorage.setItem('bymoment_paper_stock', dataStok.stok);
      updatePaperStockDisplay(dataStok.stok);
    } else if (dataStok && dataStok.error) {
      hasError = true;
      console.warn('Gagal ambil stok:', dataStok.error);
    }

    // 2. Update Daftar Promo Murni dari GAS
    if (dataPromo && dataPromo.success === true && Array.isArray(dataPromo.promos)) {
      STATE.promos = dataPromo.promos;
      localStorage.setItem('bymoment_promos', JSON.stringify(dataPromo.promos));
      renderPromoDropdown();
    } else if (dataPromo && dataPromo.error) {
      hasError = true;
      console.warn('Gagal ambil promo:', dataPromo.error);
    }

    if (!silent) {
      if (hasError) {
        const msg = (dataStok && dataStok.error) || (dataPromo && dataPromo.error) || 'Gagal sinkron data dari Google Sheets.';
        showToast(msg, 'error', 4500);
      } else {
        showToast('Data stok & promo berhasil disinkronkan!', 'success');
      }
    }
  } catch (err) {
    console.error('Gagal fetchDashboardData:', err);
    if (!silent) {
      showToast('Gagal sinkron data dari Google Sheets. Periksa URL GAS.', 'error');
    }
  }
}

async function refreshData() {
  showToast('Memperbarui data Promo & Stok Kertas...', 'info');
  await fetchDashboardData(false);
}

function updatePaperStockDisplay(stock) {
  STATE.paperStock = stock;
  const el = document.getElementById('paper-stock-num');
  const badge = document.getElementById('stock-badge');
  if (el) el.textContent = stock;

  if (badge) {
    if (stock <= 10) {
      badge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl border border-red-500/50 bg-red-500/15 text-red-300';
    } else if (stock <= 30) {
      badge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl border border-amber-500/50 bg-amber-500/15 text-amber-300';
    } else {
      badge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl border border-white/10 bg-white/[0.04] text-white';
    }
  }
}

function renderPromoDropdown() {
  const select = document.getElementById('promo-select');
  const countBadge = document.getElementById('promo-count-badge');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Tanpa Promo (Standar) --</option>';

  STATE.promos.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.kode;

    let labelTipe = '';
    const tipeClean = String(p.tipe || '').trim().toUpperCase().replace(/\s+/g, '_');
    if (tipeClean === 'POTONG_HARGA') labelTipe = `(Potongan ${formatRp(p.nilai)})`;
    else if (tipeClean === 'GRATIS_SESI') labelTipe = `(Bonus ${p.nilai} Sesi)`;
    else if (tipeClean === 'GRATIS_PRINT') labelTipe = `(Free ${p.nilai} Print)`;

    opt.textContent = `${p.kode} - ${p.nama} ${labelTipe}`;
    select.appendChild(opt);
  });

  if (currentVal && STATE.promos.some(p => p.kode === currentVal)) {
    select.value = currentVal;
  }

  if (countBadge) {
    countBadge.textContent = `${STATE.promos.length} Promo Aktif`;
  }
}

/* ── 7. ORDER CALCULATION LOGIC ──────────────────────────────── */
function updateQty(type, delta) {
  if (type === 'sesi') {
    STATE.sesi = Math.max(1, Math.min(20, STATE.sesi + delta));
    const el = document.getElementById('qty-sesi');
    if (el) el.textContent = STATE.sesi;
  } else if (type === 'print') {
    STATE.extraPrint = Math.max(0, Math.min(50, STATE.extraPrint + delta));
    const el = document.getElementById('qty-print');
    if (el) el.textContent = STATE.extraPrint;
  }
  calculateAndRenderOrder();
}

function setPreset(sesi, print) {
  STATE.sesi = sesi;
  STATE.extraPrint = print;
  const sEl = document.getElementById('qty-sesi');
  const pEl = document.getElementById('qty-print');
  if (sEl) sEl.textContent = sesi;
  if (pEl) pEl.textContent = print;
  calculateAndRenderOrder();
  showToast(`Preset: ${sesi} Sesi, ${print} Extra Print`, 'info', 1500);
}

function handlePromoChange() {
  const code = document.getElementById('promo-select').value;
  STATE.selectedPromo = STATE.promos.find(p => p.kode === code) || null;
  calculateAndRenderOrder();
}

function resetTransactionForm() {
  STATE.sesi = 1;
  STATE.extraPrint = 0;
  STATE.selectedPromo = null;
  const sEl = document.getElementById('qty-sesi');
  const pEl = document.getElementById('qty-print');
  const promoEl = document.getElementById('promo-select');
  const noteEl = document.getElementById('order-note');
  if (sEl) sEl.textContent = '1';
  if (pEl) pEl.textContent = '0';
  if (promoEl) promoEl.value = '';
  if (noteEl) noteEl.value = '';
  calculateAndRenderOrder();
  showToast('Form pesanan telah di-reset', 'info');
}

/**
 * KALKULASI LOGIKA BISNIS:
 * - Tarif Dasar: 1 Sesi Foto = Rp 25.000 (1 foto sesi + 1 lembar kertas fisik)
 * - Extra Print: Rp 10.000 / lembar
 *
 * Tipe Promo:
 * 1. POTONG_HARGA: Mengurangi Total Bayar (Rp). Stok kertas normal = Sesi + Extra Print.
 * 2. GRATIS_SESI : Total Bayar TETAP. Sesi foto total & stok kertas bertambah sebesar Nilai promo.
 * 3. GRATIS_PRINT: Total Bayar TETAP. Stok kertas bertambah sebesar Nilai promo.
 *
 * Formulasi:
 * - Total Kertas Fisik Terpotong = (Sesi Bayar + Bonus Sesi/Print Promo) + Extra Print
 * - Total Bayar (Rp) = (Sesi Bayar * 25000) + (Extra Print * 10000) - Potongan Harga Promo
 */
function calculateOrder() {
  const sesiBayar = STATE.sesi;
  const extraPrint = STATE.extraPrint;
  const promo = STATE.selectedPromo;

  let subtotalSesi = sesiBayar * PRICE_SESI;
  let subtotalPrint = extraPrint * PRICE_EXTRA_PRINT;
  let potonganHarga = 0;
  let bonusSesi = 0;
  let bonusPrint = 0;

  if (promo) {
    const pTipe = String(promo.tipe || '').trim().toUpperCase().replace(/\s+/g, '_');
    if (pTipe === 'POTONG_HARGA') {
      potonganHarga = Number(promo.nilai) || 0;
    } else if (pTipe === 'GRATIS_SESI') {
      bonusSesi = Number(promo.nilai) || 0;
    } else if (pTipe === 'GRATIS_PRINT') {
      bonusPrint = Number(promo.nilai) || 0;
    }
  }

  // Grand Total Bayar (tidak boleh negatif)
  let grandTotal = Math.max(0, subtotalSesi + subtotalPrint - potonganHarga);

  // Total Sesi Fisik (termasuk bonus sesi)
  let totalSesiNyata = sesiBayar + bonusSesi;

  // Total Kertas Fisik
  let totalKertasFisik = (sesiBayar + bonusSesi + bonusPrint) + extraPrint;

  let totalDurasiMenit = totalSesiNyata * DURATION_PER_SESI_MINUTES;

  return {
    sesiBayar,
    extraPrint,
    promo,
    subtotalSesi,
    subtotalPrint,
    potonganHarga,
    bonusSesi,
    bonusPrint,
    totalSesiNyata,
    totalKertasFisik,
    totalDurasiMenit,
    grandTotal
  };
}

function calculateAndRenderOrder() {
  const c = calculateOrder();

  // Labels & Amounts
  const sesiLabel = document.getElementById('calc-sesi-label');
  const sesiPrice = document.getElementById('calc-sesi-price');
  const printLabel = document.getElementById('calc-print-label');
  const printPrice = document.getElementById('calc-print-price');

  if (sesiLabel) sesiLabel.textContent = `Sesi Foto (${c.sesiBayar}x @ ${formatRp(PRICE_SESI)})`;
  if (sesiPrice) sesiPrice.textContent = formatRp(c.subtotalSesi);

  if (printLabel) printLabel.textContent = `Extra Print (${c.extraPrint}x @ ${formatRp(PRICE_EXTRA_PRINT)})`;
  if (printPrice) printPrice.textContent = formatRp(c.subtotalPrint);

  // Discount Row
  const discRow = document.getElementById('calc-discount-row');
  if (discRow) {
    if (c.potonganHarga > 0) {
      discRow.classList.remove('hidden');
      const dLabel = document.getElementById('calc-discount-label');
      const dPrice = document.getElementById('calc-discount-price');
      if (dLabel) dLabel.textContent = `Diskon (${c.promo.kode})`;
      if (dPrice) dPrice.textContent = `- ${formatRp(c.potonganHarga)}`;
    } else {
      discRow.classList.add('hidden');
    }
  }

  // Bonus Row
  const bonusRow = document.getElementById('calc-bonus-row');
  if (bonusRow) {
    if (c.bonusSesi > 0 || c.bonusPrint > 0) {
      bonusRow.classList.remove('hidden');
      const bLabel = document.getElementById('calc-bonus-label');
      const bVal = document.getElementById('calc-bonus-value');
      if (c.bonusSesi > 0) {
        if (bLabel) bLabel.textContent = `Bonus Promo (${c.promo.kode})`;
        if (bVal) bVal.textContent = `+${c.bonusSesi} Sesi Gratis (+${c.bonusSesi * DURATION_PER_SESI_MINUTES} mnt)`;
      } else {
        if (bLabel) bLabel.textContent = `Bonus Promo (${c.promo.kode})`;
        if (bVal) bVal.textContent = `+${c.bonusPrint} Lembar Print Gratis`;
      }
    } else {
      bonusRow.classList.add('hidden');
    }
  }

  // Kertas & Durasi
  const kertasEl = document.getElementById('calc-total-kertas');
  const durasiEl = document.getElementById('calc-total-duration');
  if (kertasEl) kertasEl.textContent = `${c.totalKertasFisik} Lembar`;
  if (durasiEl) durasiEl.textContent = `${c.totalDurasiMenit} Menit`;

  // Grand Total
  const totalEl = document.getElementById('calc-grand-total');
  const qrisEl = document.getElementById('qris-amount-display');
  if (totalEl) totalEl.textContent = formatRp(c.grandTotal);
  if (qrisEl) qrisEl.textContent = formatRp(c.grandTotal);

  // Promo Description Box
  const pDescBox = document.getElementById('promo-description');
  if (pDescBox) {
    if (c.promo) {
      pDescBox.classList.remove('hidden');
      const pTitle = document.getElementById('promo-desc-title');
      const pBody = document.getElementById('promo-desc-body');
      if (pTitle) pTitle.textContent = `${c.promo.nama} (${c.promo.tipe})`;
      const descTipe = String(c.promo.tipe || '').trim().toUpperCase().replace(/\s+/g, '_');
      if (pBody) {
        if (descTipe === 'POTONG_HARGA') {
          pBody.textContent = `Hemat ${formatRp(c.potonganHarga)}. Kertas fisik dipotong normal (${c.totalKertasFisik} lembar).`;
        } else if (descTipe === 'GRATIS_SESI') {
          pBody.textContent = `Mendapatkan bonus ${c.bonusSesi} sesi foto (durasi bertambah ${c.bonusSesi * DURATION_PER_SESI_MINUTES} menit & kertas fisik +${c.bonusSesi} lembar). Total bayar tetap.`;
        } else if (descTipe === 'GRATIS_PRINT') {
          pBody.textContent = `Mendapatkan bonus ${c.bonusPrint} lembar cetak fisik tanpa biaya tambahan. Total bayar tetap.`;
        }
      }
    } else {
      pDescBox.classList.add('hidden');
    }
  }
}

/* ── 8. PAYMENT & TRANSACTION PROCESSING ─────────────────────── */
function submitPayment(method) {
  STATE.pendingMethod = method;
  if (method === 'QRIS') {
    const qrisModal = document.getElementById('qris-modal');
    if (qrisModal) qrisModal.classList.remove('hidden');
  } else {
    executePayment('Cash');
  }
}

function confirmQrisPayment() {
  closeQrisModal();
  executePayment('QRIS');
}

function closeQrisModal() {
  const qModal = document.getElementById('qris-modal');
  if (qModal) qModal.classList.add('hidden');
}

/**
 * TAHAP 1 PEMBAYARAN:
 * - Catat transaksi ke Tab "Transaksi" dengan Status = 'Berjalan'
 * - Backend langsung memotong stok di Tab "Stok" Sel B2
 * - Tampilkan Modal Struk & Masukkan sesi ke Panel Antrean
 */
async function executePayment(method) {
  const calc = calculateOrder();
  const noteEl = document.getElementById('order-note');
  const note = noteEl ? noteEl.value.trim() : '';
  const trxId = generateTransactionId();
  const now = new Date();
  const waktuStr = now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const cashier = STATE.currentUser ? (STATE.currentUser.nama || STATE.currentUser.username) : 'Kasir';

  // Persiapan data item antrean
  const queueItem = {
    id: trxId,
    waktu: waktuStr,
    sesi: calc.sesiBayar,
    extraPrint: calc.extraPrint,
    totalBayar: calc.grandTotal,
    metode: method,
    status: 'Berjalan', // Status awal sesuai spesifikasi
    promo: calc.promo ? calc.promo.kode : '-',
    kertasTerpotong: calc.totalKertasFisik,
    durasiDetik: calc.totalDurasiMenit * 60,
    timeLeft: calc.totalDurasiMenit * 60,
    isTimerRunning: false,
    cashier: cashier,
    note: note
  };

  // Tambahkan ke antrean lokal
  STATE.queue.unshift(queueItem);
  saveQueuesToLocalStorage();
  renderQueueList();

  // Simpan untuk modal struk
  STATE.lastTransaction = queueItem;

  // Update estimasi sisa stok lokal
  if (STATE.paperStock > 0) {
    updatePaperStockDisplay(Math.max(0, STATE.paperStock - calc.totalKertasFisik));
  }

  showToast(`Transaksi ${trxId} tercatat! Sesi Siap Dimulai.`, 'success', 3500);

  // Tampilkan Modal Struk Thermal
  openReceiptModal(queueItem);

  // Reset form order
  resetTransactionForm();

  // Kirim request ke Google Apps Script (action: 'create')
  syncCreateTransaction(queueItem);
}

async function syncCreateTransaction(trx) {
  try {
    const url = (typeof STATE !== 'undefined' && STATE.gasUrl)
      ? STATE.gasUrl
      : DEFAULT_GAS_URL;

    const bodyData = Object.assign({ action: 'create' }, trx);

    console.log("=== DATA TRANSAKSI DIKIRIM KE GAS ===");
    console.log(JSON.stringify(bodyData, null, 2));
    console.log("kertasTerpotong:", bodyData.kertasTerpotong);
    console.log("sesi:", bodyData.sesi);
    console.log("extraPrint:", bodyData.extraPrint);

    const result = await safeGasFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(bodyData)
    });

    console.log("=== RESPON DARI GAS ===");
    console.log(result);

    if (result && result.success === true && typeof result.sisaStok === 'number') {
      STATE.paperStock = result.sisaStok;

      localStorage.setItem(
        'bymoment_paper_stock',
        result.sisaStok
      );

      updatePaperStockDisplay(result.sisaStok);
    }

    return result;

  } catch (error) {
    console.error("Gagal sinkron create trx ke GAS:", error);
  }
}

/* ── 9. MODAL STRUK THERMAL ──────────────────────────────────── */
function openReceiptModal(trx) {
  if (!trx) return;
  const rcptId = document.getElementById('rcpt-id');
  const rcptTime = document.getElementById('rcpt-time');
  const rcptCashier = document.getElementById('rcpt-cashier');
  const rcptMethod = document.getElementById('rcpt-method');
  const rcptStatus = document.getElementById('rcpt-status');
  const rcptSesiDesc = document.getElementById('rcpt-sesi-desc');
  const rcptSesiPrice = document.getElementById('rcpt-sesi-price');

  if (rcptId) rcptId.textContent = trx.id;
  if (rcptTime) rcptTime.textContent = trx.waktu;
  if (rcptCashier) rcptCashier.textContent = trx.cashier || 'Admin';
  if (rcptMethod) rcptMethod.textContent = trx.metode;
  if (rcptStatus) rcptStatus.textContent = trx.status;

  if (rcptSesiDesc) rcptSesiDesc.textContent = `${trx.sesi}x Sesi Foto (@ ${formatRp(PRICE_SESI)})`;
  if (rcptSesiPrice) rcptSesiPrice.textContent = formatRp(trx.sesi * PRICE_SESI);

  const printRow = document.getElementById('rcpt-print-row');
  if (printRow) {
    if (trx.extraPrint > 0) {
      printRow.classList.remove('hidden');
      const pDesc = document.getElementById('rcpt-print-desc');
      const pPrice = document.getElementById('rcpt-print-price');
      if (pDesc) pDesc.textContent = `${trx.extraPrint}x Extra Print`;
      if (pPrice) pPrice.textContent = formatRp(trx.extraPrint * PRICE_EXTRA_PRINT);
    } else {
      printRow.classList.add('hidden');
    }
  }

  const promoRow = document.getElementById('rcpt-promo-row');
  if (promoRow) {
    if (trx.promo && trx.promo !== '-') {
      promoRow.classList.remove('hidden');
      const pName = document.getElementById('rcpt-promo-name');
      const pVal = document.getElementById('rcpt-promo-val');
      if (pName) pName.textContent = `Promo: ${trx.promo}`;
      if (pVal) pVal.textContent = 'Diterapkan';
    } else {
      promoRow.classList.add('hidden');
    }
  }

  const totalEl = document.getElementById('rcpt-total');
  const kertasEl = document.getElementById('rcpt-kertas');
  if (totalEl) totalEl.textContent = formatRp(trx.totalBayar);
  if (kertasEl) kertasEl.textContent = `${trx.kertasTerpotong} Lembar Fisik`;

  // Salin konten struk ke container #print-area mandiri untuk isolasi print
  const printArea = document.getElementById('print-area');
  const rcptContainer = document.getElementById('thermal-receipt-container');
  if (printArea && rcptContainer) {
    printArea.innerHTML = rcptContainer.outerHTML;
  }

  const modal = document.getElementById('receipt-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeReceiptModal() {
  const modal = document.getElementById('receipt-modal');
  if (modal) modal.classList.add('hidden');
}

function printThermalReceipt() {
  // Pastikan #print-area memiliki markup struk terkini sebelum dicetak
  const printArea = document.getElementById('print-area');
  const rcptContainer = document.getElementById('thermal-receipt-container');
  if (printArea && rcptContainer) {
    printArea.innerHTML = rcptContainer.outerHTML;
  }
  window.print();
}

/* ── 10. TIMER SESI & QUEUE WORKFLOW ─────────────────────────── */
const activeIntervals = {};

function resumeActiveTimers() {
  STATE.queue.forEach(item => {
    if (item.status === 'Berjalan' && item.isTimerRunning && item.timeLeft > 0) {
      startCountdown(item.id);
    }
  });
}

function renderQueueList() {
  const listEl = document.getElementById('queue-list');
  const emptyEl = document.getElementById('queue-empty');
  const badgeEl = document.getElementById('queue-badge');
  if (!listEl) return;

  const activeCount = STATE.queue.filter(q => q.status === 'Berjalan').length;
  if (badgeEl) badgeEl.textContent = `${activeCount} Sesi Berjalan`;

  // Bersihkan list elemen (kecuali empty state)
  listEl.querySelectorAll('.queue-item-card').forEach(el => el.remove());

  if (STATE.queue.length === 0) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  STATE.queue.forEach(item => {
    const card = document.createElement('div');
    card.className = `queue-item-card glass-card p-4 border transition-all ${item.status === 'Selesai'
      ? 'border-emerald-500/20 bg-emerald-950/10'
      : item.isTimerRunning
        ? 'border-blue-500/40 bg-blue-950/25 shadow-lg shadow-blue-950/30'
        : 'border-white/10'
      }`;
    card.id = `card-${item.id}`;

    const isRunning = item.isTimerRunning;
    const isDone = item.status === 'Selesai';
    const timerText = isDone ? '00:00' : formatTimeSeconds(item.timeLeft);

    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="font-black text-white text-sm font-mono">${item.id}</span>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${isDone ? 'badge-green' : isRunning ? 'badge-blue animate-pulse' : 'badge-yellow'
      }">
              ${isDone ? '✅ Selesai' : isRunning ? '▶️ Sesi Berjalan' : '⏳ Siap / Jeda'}
            </span>
            <span class="text-white/40 text-[11px] font-mono">${item.metode}</span>
            ${item.promo !== '-' ? `<span class="badge-cyan text-[10px] px-1.5 py-0.2 rounded font-bold">${item.promo}</span>` : ''}
          </div>
          <div class="flex items-center gap-2 text-xs text-white/60 flex-wrap">
            <span>📸 ${item.sesi} Sesi</span>
            <span>•</span>
            <span>🖨️ ${item.kertasTerpotong} Lbr Kertas</span>
            <span>•</span>
            <span class="text-blue-400 font-bold">${formatRp(item.totalBayar)}</span>
          </div>
          ${item.note ? `<p class="text-white/40 text-xs mt-1 truncate">📝 ${item.note}</p>` : ''}
          <p class="text-white/20 text-[10px] mt-0.5">${item.waktu}</p>
        </div>

        <!-- Timer Display & Action Buttons -->
        <div class="flex flex-col items-end gap-2 shrink-0">
          <div id="timer-display-${item.id}" class="font-mono text-2xl font-black tabular-nums tracking-wider ${isDone ? 'text-emerald-400' : isRunning ? 'text-blue-400 animate-pulse' : 'text-white/80'
      }">
            ${timerText}
          </div>

          <div class="flex items-center gap-1.5">
            ${!isDone ? `
              ${!isRunning ? `
                <button onclick="startCountdown('${item.id}')"
                  class="btn-neon px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1">
                  <span>▶️</span> Start Sesi
                </button>
              ` : `
                <button onclick="pauseCountdown('${item.id}')"
                  class="glass-card px-2.5 py-1.5 rounded-lg text-xs font-bold text-amber-300 border border-amber-500/30 hover:bg-amber-500/10">
                  ⏸️
                </button>
              `}
              <button onclick="finishSessionManual('${item.id}')"
                title="Selesaikan Sesi Manual"
                class="btn-green px-2.5 py-1.5 rounded-lg text-xs font-bold">
                ✓ Selesai
              </button>
            ` : `
              <button onclick="openReceiptModalForId('${item.id}')"
                class="glass-card px-2.5 py-1.5 rounded-lg text-xs font-bold text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10 flex items-center gap-1">
                <span>🖨️</span> Nota
              </button>
            `}
          </div>
        </div>
      </div>
    `;

    listEl.appendChild(card);
  });
}

function openReceiptModalForId(id) {
  const item = STATE.queue.find(q => q.id === id);
  if (item) openReceiptModal(item);
}

function startCountdown(id) {
  const item = STATE.queue.find(q => q.id === id);
  if (!item || item.status === 'Selesai') return;

  item.isTimerRunning = true;
  saveQueuesToLocalStorage();
  renderQueueList();

  if (activeIntervals[id]) clearInterval(activeIntervals[id]);

  activeIntervals[id] = setInterval(() => {
    item.timeLeft--;
    const timerEl = document.getElementById(`timer-display-${id}`);
    if (timerEl) {
      timerEl.textContent = formatTimeSeconds(item.timeLeft);
    }

    if (item.timeLeft <= 0) {
      clearInterval(activeIntervals[id]);
      delete activeIntervals[id];
      handleSessionFinished(item);
    }
  }, 1000);

  showToast(`Sesi ${id} dimulai! Hitung mundur aktif.`, 'info', 2000);
}

function pauseCountdown(id) {
  const item = STATE.queue.find(q => q.id === id);
  if (!item) return;

  item.isTimerRunning = false;
  if (activeIntervals[id]) {
    clearInterval(activeIntervals[id]);
    delete activeIntervals[id];
  }
  saveQueuesToLocalStorage();
  renderQueueList();
  showToast(`Timer ${id} dijeda.`, 'warning', 1500);
}

function finishSessionManual(id) {
  const item = STATE.queue.find(q => q.id === id);
  if (!item) return;
  if (confirm(`Selesaikan sesi ${id} sekarang?`)) {
    if (activeIntervals[id]) {
      clearInterval(activeIntervals[id]);
      delete activeIntervals[id];
    }
    item.timeLeft = 0;
    handleSessionFinished(item);
  }
}

/**
 * TAHAP 3 SESI SELESAI:
 * - Ketika waktu mencapai 00:00 atau diklik selesai manual
 * - Frontend menembak update status ke Backend (action: 'updateStatus')
 * - Backend mencari ID Transaksi dan mengubah Status menjadi 'Selesai'
 */
async function handleSessionFinished(item) {
  item.status = 'Selesai';
  item.isTimerRunning = false;
  saveQueuesToLocalStorage();
  renderQueueList();

  playFinishAlarm();
  showToast(`🔔 SESI ${item.id} TELAH SELESAI! Waktu habis.`, 'success', 6000);

  // Web Notification jika diizinkan
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('📸 Photobooth', {
      body: `Sesi ${item.id} telah selesai! Terima kasih.`,
      icon: 'https://cdn-icons-png.flaticon.com/512/3135/3135715.png'
    });
  }

  // Kirim dalam bentuk Object dengan kunci 'id' dan 'status'
  syncUpdateStatus({
    id: item.id,
    status: 'Selesai'
  });
}

async function syncUpdateStatus(payload) {
  try {
    const url = (typeof STATE !== 'undefined' && STATE.gasUrl) ? STATE.gasUrl : DEFAULT_GAS_URL;
    const bodyData = Object.assign({ action: 'updateStatus' }, payload);

    const result = await safeGasFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(bodyData)
    });

    console.log("Respon Update Status:", result);
    return result;

  } catch (error) {
    console.error("Gagal sinkron updateStatus ke GAS:", error);
  }
}

function clearCompletedSessions() {
  STATE.queue = STATE.queue.filter(q => q.status !== 'Selesai');
  saveQueuesToLocalStorage();
  renderQueueList();
  showToast('Sesi yang telah selesai dibersihkan.', 'info');
}

function saveQueuesToLocalStorage() {
  // Simpan maksimal 30 transaksi terakhir di lokal
  localStorage.setItem('bymoment_active_queues', JSON.stringify(STATE.queue.slice(0, 30)));
}

/* ── 11. AUDIO ALARM ─────────────────────────────────────────── */
function playFinishAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = [784, 880, 988, 1046, 1318];
    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime + idx * 0.16;
      osc.frequency.setValueAtTime(freq, t);
      osc.type = 'triangle';
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.start(t);
      osc.stop(t + 0.28);
    });
  } catch (e) {
    console.warn('Audio context playback failed:', e);
  }
}

/* ── 12. GAS CONFIG MODAL ────────────────────────────────────── */
function openGasModal() {
  const urlInput = document.getElementById('gas-url-input');
  const feedback = document.getElementById('gas-test-feedback');
  const modal = document.getElementById('gas-modal');
  if (urlInput) urlInput.value = STATE.gasUrl;
  if (feedback) feedback.textContent = '';
  if (modal) modal.classList.remove('hidden');
}

function closeGasModal() {
  const modal = document.getElementById('gas-modal');
  if (modal) modal.classList.add('hidden');
}

function saveGasSettings() {
  const urlInput = document.getElementById('gas-url-input');
  const url = urlInput ? urlInput.value.trim() : '';
  STATE.gasUrl = url || DEFAULT_GAS_URL;
  localStorage.setItem('bymoment_gas_url', STATE.gasUrl);
  closeGasModal();
  showToast('Konfigurasi URL Web App GAS disimpan!', 'success');
  // Segera sinkronkan ulang stok & promo
  fetchDashboardData(false);
}

async function testGasConnection() {
  const urlInput = document.getElementById('gas-url-input');
  const url = (urlInput ? urlInput.value.trim() : '') || STATE.gasUrl;
  const feedback = document.getElementById('gas-test-feedback');
  const btn = document.getElementById('gas-test-btn');

  if (!url) {
    if (feedback) feedback.innerHTML = '<span class="text-amber-400">⚠️ Harap masukkan URL Web App terlebih dahulu.</span>';
    return;
  }

  if (btn) btn.disabled = true;
  if (feedback) feedback.innerHTML = '<span class="text-cyan-400">Sedang menguji koneksi...</span>';

  try {
    const sep = url.includes('?') ? '&' : '?';
    const testUrl = `${url}${sep}action=status&_ts=${Date.now()}`;
    const data = await safeGasFetch(testUrl, { redirect: 'follow' });

    if (feedback) {
      if (data && (data.success === true || data.status === 'ok')) {
        feedback.innerHTML = `<span class="text-emerald-400">✅ Terhubung Sukses! Versi: ${data.version || '2.0'}</span>`;
      } else {
        feedback.innerHTML = `<span class="text-amber-400">⚠️ ${data && data.error ? data.error : 'Respon diterima namun status bukan ok.'}</span>`;
      }
    }
  } catch (err) {
    if (feedback) feedback.innerHTML = `<span class="text-red-400">❌ Gagal terhubung: ${err.message || 'Periksa URL GAS'}</span>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Minta izin notifikasi browser
if ('Notification' in window && Notification.permission === 'default') {
  setTimeout(() => Notification.requestPermission(), 4000);
}
