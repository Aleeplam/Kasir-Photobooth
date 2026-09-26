const SPREADSHEET_ID = '1anXF9HimUnXu1GYxhgORXSAUPxF0kvn6mJ5LVNr22kU'; // <-- Ganti dengan ID Anda jika menggunakan standalone script

// ── NAMA TAB / SHEET ────────────────────────────────────────────────
const SHEET_USERS     = 'Users';
const SHEET_TRANSAKSI = 'Transaksi';
const SHEET_STOK      = 'Stok';
const SHEET_PROMO     = 'Promo';

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/**
 * Helper untuk response JSON (CORS-friendly)
 */
function jsonOutput(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ────────────────────────────────────────────────────────────────────
// 1. doGet: Health Check, Login Kasir, & Ambil Data Promo / Stok
// ────────────────────────────────────────────────────────────────────
/**
 * GET requests handler
 * Query parameters:
 *   - ?action=login&username=...&password=...
 *   - ?action=getPromos
 *   - ?action=getStok
 *   - ?action=status
 */
function doGet(e) {
  try {
    const params   = (e && e.parameter) ? e.parameter : {};
    const action   = params.action || '';
    const username = params.username || '';
    const password = params.password || '';

    // Action 1: Login Kasir
    if (action === 'login') {
      return handleLogin(username, password);
    }

    // Action 2: Ambil Daftar Promo Aktif
    if (action === 'getPromos') {
      const promos = getActivePromos();
      return jsonOutput({ success: true, promos: promos });
    }

    // Action 3: Ambil Sisa Stok Kertas
    if (action === 'getStok') {
      const stok = getPaperStock();
      return jsonOutput({ success: true, stok: stok });
    }

    // Default: Health Check & Informasi API
    return jsonOutput({
      success: true,
      status : 'ok',
      service: 'Bymoment Booth Web POS API',
      version: '2.0.0',
      time   : new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    });

  } catch (err) {
    return jsonOutput({ success: false, error: err.toString() });
  }
}

// ────────────────────────────────────────────────────────────────────
// 2. doPost: Create Transaksi & Update Status
// ────────────────────────────────────────────────────────────────────
/**
 * POST requests handler
 * Menerima JSON body:
 * 1. action = 'create' (atau createTransaction):
 *    {
 *      action: 'create',
 *      id: 'TRX-...',
 *      waktu: '24/09/2026, 14:00:00',
 *      sesi: 1,
 *      extraPrint: 0,
 *      totalBayar: 25000,
 *      metode: 'Cash' | 'QRIS',
 *      status: 'Berjalan',
 *      promo: 'BOGO' | '-',
 *      kertasTerpotong: 2
 *    }
 *
 * 2. action = 'updateStatus':
 *    {
 *      action: 'updateStatus',
 *      id: 'TRX-...',
 *      status: 'Selesai'
 *    }
 */
function doPost(e) {
  try {
    let payload = {};

    // Parse JSON dari postData
    if (e && e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (parseErr) {
        // Fallback jika dikirim x-www-form-urlencoded
        payload = e.parameter || {};
      }
    } else if (e && e.parameter) {
      payload = e.parameter;
    }

    // Tentukan action (bisa dari payload.action atau query param ?action=...)
    const action = payload.action || (e && e.parameter && e.parameter.action) || 'create';

    // ── AKSI 1: CREATE TRANSACTION ──
    if (action === 'create' || action === 'createTransaction') {
      if (!payload.id) {
        return jsonOutput({ success: false, error: 'Field "id" transaksi diperlukan.' });
      }

      const result = handleCreateTransaction(payload);
      return jsonOutput(result);
    }

    // ── AKSI 2: UPDATE STATUS TRANSACTION ──
    if (action === 'updateStatus') {
      if (!payload.id) {
        return jsonOutput({ success: false, error: 'Field "id" transaksi diperlukan untuk update status.' });
      }

      const newStatus = payload.status || 'Selesai';
      const result = handleUpdateStatus(payload.id, newStatus);
      return jsonOutput(result);
    }

    return jsonOutput({ success: false, error: 'Action tidak dikenali: ' + action });

  } catch (err) {
    return jsonOutput({ success: false, error: err.toString() });
  }
}

// ────────────────────────────────────────────────────────────────────
// 3. HANDLER FUNCTIONS
// ────────────────────────────────────────────────────────────────────

/**
 * Handle Login: Memvalidasi user dan mengembalikan data promo aktif + stok kertas
 */
function handleLogin(username, password) {
  if (!username || !password) {
    return jsonOutput({ success: false, error: 'Username dan Password wajib diisi.' });
  }

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_USERS);

  if (!sheet) {
    return jsonOutput({ success: false, error: `Sheet "${SHEET_USERS}" belum dibuat. Jalankan setupSheets().` });
  }

  const data = sheet.getDataRange().getValues();
  // Baris 1: Header ['Username', 'Password', 'Nama']
  let authenticatedUser = null;

  for (let i = 1; i < data.length; i++) {
    const rowUser = String(data[i][0] || '').trim();
    const rowPass = String(data[i][1] || '').trim();
    const rowNama = String(data[i][2] || rowUser).trim();

    if (rowUser.toLowerCase() === username.trim().toLowerCase() && rowPass === password.trim()) {
      authenticatedUser = {
        username: rowUser,
        nama    : rowNama
      };
      break;
    }
  }

  if (authenticatedUser) {
    // Ambil daftar Promo yang Aktif
    const activePromos = getActivePromos();
    // Ambil Stok Kertas saat ini
    const paperStock = getPaperStock();

    return jsonOutput({
      success : true,
      message : 'Login berhasil!',
      user    : authenticatedUser,
      promos  : activePromos,
      stok    : paperStock
    });
  }

  return jsonOutput({
    success: false,
    error  : 'Username atau Password salah!'
  });
}

/**
 * Ambil daftar Promo yang berstatus 'Aktif' dari Tab Promo
 * Tab "Promo" (Kolom: Kode Promo, Nama Promo, Tipe Promo, Nilai, Status)
 */
function getActivePromos() {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_PROMO);
    if (!sheet) return [];

    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];

    const promos = [];
    for (let i = 1; i < data.length; i++) {
      const kode   = String(data[i][0] || '').trim();
      const nama   = String(data[i][1] || '').trim();
      const tipe   = String(data[i][2] || '').trim().toUpperCase(); // POTONG_HARGA, GRATIS_SESI, GRATIS_PRINT
      const nilai  = Number(data[i][3]) || 0;
      const status = String(data[i][4] || '').trim();

      if (status.toLowerCase() === 'aktif' && kode) {
        promos.push({
          kode  : kode,
          nama  : nama,
          tipe  : tipe,
          nilai : nilai,
          status: status
        });
      }
    }
    return promos;
  } catch (e) {
    Logger.log('Error getActivePromos: ' + e);
    return [];
  }
}

/**
 * Ambil sisa stok kertas dari Tab Stok Sel B2
 * Tab "Stok" (Baris 1: Header | Baris 2 Sel A2: "Kertas Foto", Sel B2: Angka Stok Fisik)
 */
function getPaperStock() {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_STOK);
    if (!sheet) return 0;

    const val = sheet.getRange('B2').getValue();
    return Number(val) || 0;
  } catch (e) {
    Logger.log('Error getPaperStock: ' + e);
    return 0;
  }
}

/**
 * Handle Create Transaction:
 * 1. Simpan baris ke Tab "Transaksi" dengan Status = 'Berjalan'
 * 2. Potong stok kertas foto di Tab "Stok" Sel B2
 */
function handleCreateTransaction(data) {
  const ss = getSpreadsheet();

  // 1. Sheet Transaksi
  let trxSheet = ss.getSheetByName(SHEET_TRANSAKSI);
  if (!trxSheet) {
    trxSheet = createTrxSheet(ss);
  }

  const trxId      = String(data.id || '').trim();
  const waktu      = data.waktu || new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const sesiBayar  = Number(data.sesi) || 1;
  const extraPrint = Number(data.extraPrint || data.print) || 0;
  const totalBayar = Number(data.totalBayar || data.total) || 0;
  const metode     = String(data.metode || data.method || 'Cash').trim();
  const status     = 'Berjalan'; // Wajib 'Berjalan' saat dibuat
  const promoName  = String(data.promo || '-').trim();

  // Hitung jumlah kertas terpotong
  // Total Kertas Fisik Terpotong = (Jumlah Sesi Bayar + Bonus Sesi/Print Promo) + Extra Print
  let kertasTerpotong = Number(data.kertasTerpotong);
  if (isNaN(kertasTerpotong) || kertasTerpotong <= 0) {
    kertasTerpotong = sesiBayar + extraPrint;
  }

  // Susun data baris
  // Kolom: ID, Waktu, Jumlah Sesi, Extra Print, Total Bayar, Metode, Status, Promo
  const row = [
    trxId,
    waktu,
    sesiBayar,
    extraPrint,
    totalBayar,
    metode,
    status,
    promoName
  ];

  trxSheet.appendRow(row);
  const lastRow = trxSheet.getLastRow();

  // Format Total Bayar sebagai Rupiah di kolom ke-5 (Kolom E)
  trxSheet.getRange(lastRow, 5).setNumberFormat('"Rp "#,##0');

  // 2. Potong Stok Kertas Fisik di Tab "Stok" Sel B2
  let sisaStok = 0;
  let stokSheet = ss.getSheetByName(SHEET_STOK);
  if (stokSheet) {
    const currentStock = Number(stokSheet.getRange('B2').getValue()) || 0;
    sisaStok = Math.max(0, currentStock - kertasTerpotong);
    stokSheet.getRange('B2').setValue(sisaStok);
  }

  return {
    success        : true,
    message        : 'Transaksi berhasil dicatat dengan status Berjalan',
    trxId          : trxId,
    status         : status,
    rowNumber      : lastRow,
    kertasTerpotong: kertasTerpotong,
    sisaStok       : sisaStok
  };
}

/**
 * Handle Update Status:
 * Mencari ID Transaksi di kolom A Tab "Transaksi" lalu mengubah status menjadi 'Selesai' (kolom G)
 */
function handleUpdateStatus(trxId, newStatus) {
  const ss = getSpreadsheet();
  const trxSheet = ss.getSheetByName(SHEET_TRANSAKSI);

  if (!trxSheet) {
    return { success: false, error: `Sheet "${SHEET_TRANSAKSI}" tidak ditemukan.` };
  }

  const data = trxSheet.getDataRange().getValues();
  if (data.length <= 1) {
    return { success: false, error: 'Sheet Transaksi masih kosong.' };
  }

  // Kolom A adalah ID Transaksi (index 0)
  // Kolom G adalah Status (index 6)
  let foundRow = -1;
  const targetId = String(trxId).trim().toLowerCase();

  for (let i = 1; i < data.length; i++) {
    const rowId = String(data[i][0] || '').trim().toLowerCase();
    if (rowId === targetId) {
      foundRow = i + 1; // 1-indexed baris spreadsheet
      break;
    }
  }

  if (foundRow === -1) {
    return { success: false, error: `Transaksi dengan ID "${trxId}" tidak ditemukan.` };
  }

  // Update Status di Kolom G (kolom ke-7)
  const statusCell = trxSheet.getRange(foundRow, 7);
  statusCell.setValue(newStatus);

  return {
    success  : true,
    message  : `Status transaksi ${trxId} berhasil diperbarui menjadi "${newStatus}"`,
    trxId    : trxId,
    newStatus: newStatus,
    rowNumber: foundRow
  };
}

// ────────────────────────────────────────────────────────────────────
// 4. SETUP SHEET OTOMATIS (Jalankan sekali dari Script Editor)
// ────────────────────────────────────────────────────────────────────
/**
 * Jalankan fungsi ini satu kali (Run > setupSheets) untuk menginisialisasi
 * seluruh tab, header, format warna, dan sample data sesuai spesifikasi.
 */
function setupSheets() {
  const ss = getSpreadsheet();

  // ── 1. Tab Users ──
  // Kolom: Username, Password, Nama
  let usersSheet = ss.getSheetByName(SHEET_USERS);
  if (!usersSheet) {
    usersSheet = ss.insertSheet(SHEET_USERS);
  }
  const usersHeaders = ['Username', 'Password', 'Nama'];
  usersSheet.getRange(1, 1, 1, usersHeaders.length).setValues([usersHeaders]);
  formatHeader(usersSheet, 1, usersHeaders.length, '#784BA0');
  usersSheet.setFrozenRows(1);

  if (usersSheet.getLastRow() <= 1) {
    usersSheet.appendRow(['admin', 'bymoment123', 'Administrator Booth']);
    usersSheet.appendRow(['kasir1', 'kasir123', 'Alya Kasir']);
  }
  usersSheet.autoResizeColumns(1, usersHeaders.length);

  // ── 2. Tab Transaksi ──
  // Kolom: ID, Waktu, Jumlah Sesi, Extra Print, Total Bayar, Metode, Status, Promo
  let trxSheet = ss.getSheetByName(SHEET_TRANSAKSI);
  if (!trxSheet) {
    trxSheet = ss.insertSheet(SHEET_TRANSAKSI);
  }
  const trxHeaders = ['ID', 'Waktu', 'Jumlah Sesi', 'Extra Print', 'Total Bayar', 'Metode', 'Status', 'Promo'];
  trxSheet.getRange(1, 1, 1, trxHeaders.length).setValues([trxHeaders]);
  formatHeader(trxSheet, 1, trxHeaders.length, '#FF3CAC');
  trxSheet.setFrozenRows(1);
  trxSheet.autoResizeColumns(1, trxHeaders.length);

  // ── 3. Tab Stok ──
  // Baris 1: Header | Baris 2 Sel A2: "Kertas Foto", Sel B2: Angka Stok Fisik
  let stokSheet = ss.getSheetByName(SHEET_STOK);
  if (!stokSheet) {
    stokSheet = ss.insertSheet(SHEET_STOK);
  }
  const stokHeaders = ['Nama Barang', 'Jumlah Stok Fisik'];
  stokSheet.getRange(1, 1, 1, stokHeaders.length).setValues([stokHeaders]);
  formatHeader(stokSheet, 1, stokHeaders.length, '#00D4FF');
  stokSheet.setFrozenRows(1);

  if (stokSheet.getLastRow() <= 1) {
    stokSheet.appendRow(['Kertas Foto', 150]);
  }
  stokSheet.autoResizeColumns(1, stokHeaders.length);

  // ── 4. Tab Promo ──
  // Kolom: Kode Promo, Nama Promo, Tipe Promo, Nilai, Status
  let promoSheet = ss.getSheetByName(SHEET_PROMO);
  if (!promoSheet) {
    promoSheet = ss.insertSheet(SHEET_PROMO);
  }
  const promoHeaders = ['Kode Promo', 'Nama Promo', 'Tipe Promo', 'Nilai', 'Status'];
  promoSheet.getRange(1, 1, 1, promoHeaders.length).setValues([promoHeaders]);
  formatHeader(promoSheet, 1, promoHeaders.length, '#10b981');
  promoSheet.setFrozenRows(1);

  if (promoSheet.getLastRow() <= 1) {
    // Sesuai 3 Tipe Promo Bisnis:
    // 1. POTONG_HARGA: Potongan harga Rp (stok kertas normal)
    // 2. GRATIS_SESI  : Bayar 1 Sesi dapat bonus sesi (durasi & stok kertas bertambah)
    // 3. GRATIS_PRINT : Gratis print kertas (stok kertas bertambah tanpa biaya extra)
    promoSheet.appendRow(['DISKON10K', 'Diskon Hemat Rp 10.000', 'POTONG_HARGA', 10000, 'Aktif']);
    promoSheet.appendRow(['BOGO', 'Buy 1 Get 1 Sesi Foto', 'GRATIS_SESI', 1, 'Aktif']);
    promoSheet.appendRow(['FREEPRINT', 'Gratis 1 Lembar Cetak Foto', 'GRATIS_PRINT', 1, 'Aktif']);
  }
  promoSheet.autoResizeColumns(1, promoHeaders.length);

  Logger.log('✅ Setup 4 Sheet Bymoment Booth Berhasil!');
  try {
    SpreadsheetApp.getUi().alert('✅ Setup Berhasil! Ke-4 Sheet (Users, Transaksi, Stok, Promo) telah siap digunakan.');
  } catch (e) {
    // Abaikan jika dipanggil dari trigger non-UI
  }
}

/**
 * Format Header Style
 */
function formatHeader(sheet, row, numCols, bgColor) {
  const range = sheet.getRange(row, 1, 1, numCols);
  range.setFontWeight('bold');
  range.setBackground(bgColor);
  range.setFontColor('#ffffff');
}

/**
 * Helper buat sheet transaksi jika belum ada
 */
function createTrxSheet(ss) {
  const sheet = ss.insertSheet(SHEET_TRANSAKSI);
  const headers = ['ID', 'Waktu', 'Jumlah Sesi', 'Extra Print', 'Total Bayar', 'Metode', 'Status', 'Promo'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  formatHeader(sheet, 1, headers.length, '#FF3CAC');
  sheet.setFrozenRows(1);
  return sheet;
}
