/**
 * ================================================================
 *  BYMOMENT BOOTH — Google Apps Script Backend
 *  Deploy sebagai Web App:
 *    - Execute as: Me
 *    - Who has access: Anyone
 * ================================================================
 *
 *  SETUP GOOGLE SHEETS:
 *  1. Buat Google Spreadsheet baru
 *  2. Buat 2 tab/sheet:
 *     a) "Users"      → Kolom: Username | Password
 *     b) "Transaksi"  → Kolom: ID | Waktu | Jumlah Sesi | Extra Print | Total Bayar | Metode | Status
 *  3. Isi tab Users dengan data login (contoh: admin | bymoment123)
 *  4. Paste kode ini di Script Editor (Extensions > Apps Script)
 *  5. Deploy > New Deployment > Web App
 *  6. Copy URL dan masukkan ke aplikasi POS via menu "Konfigurasi GAS"
 * ================================================================
 */

// ── Konfigurasi ──────────────────────────────────────────────────
const SPREADSHEET_ID = 'GANTI_DENGAN_ID_SPREADSHEET_ANDA';
// Cara mendapatkan ID: dari URL spreadsheet
// https://docs.google.com/spreadsheets/d/[ID_ADA_DI_SINI]/edit

const SHEET_USERS      = 'Users';
const SHEET_TRANSAKSI  = 'Transaksi';

// ── CORS Headers helper ──────────────────────────────────────────
function corsOutput(data) {
  const output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ── doGet: Login Verification ─────────────────────────────────────
/**
 * Dipanggil saat frontend melakukan GET request untuk login.
 * URL: ?action=login&username=xxx&password=yyy
 */
function doGet(e) {
  try {
    const action   = e.parameter.action   || '';
    const username = e.parameter.username || '';
    const password = e.parameter.password || '';

    if (action === 'login') {
      return handleLogin(username, password);
    }

    // Default: health check
    return corsOutput({
      status : 'ok',
      message: 'Bymoment Booth POS API aktif ✅',
      version: '1.0.0',
      time   : new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    });

  } catch (err) {
    return corsOutput({ success: false, error: err.message });
  }
}

// ── doPost: Record Transaction ────────────────────────────────────
/**
 * Dipanggil saat frontend mengirimkan data transaksi setelah pembayaran.
 * Body JSON: { id, timestamp, sesi, print, total, method, status }
 */
function doPost(e) {
  try {
    let data = {};

    // Parse body JSON
    if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    }

    // Validasi field yang diperlukan
    if (!data.id) {
      return corsOutput({ success: false, error: 'Field "id" diperlukan.' });
    }

    // Simpan ke sheet Transaksi
    const result = recordTransaction(data);
    return corsOutput({ success: true, row: result });

  } catch (err) {
    return corsOutput({ success: false, error: err.message });
  }
}

// ── Handler: Login ────────────────────────────────────────────────
function handleLogin(username, password) {
  if (!username || !password) {
    return corsOutput({ success: false, error: 'Username dan password diperlukan.' });
  }

  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_USERS);

  if (!sheet) {
    return corsOutput({ success: false, error: `Sheet "${SHEET_USERS}" tidak ditemukan.` });
  }

  const data = sheet.getDataRange().getValues();

  // Baris pertama diasumsikan header (Username, Password)
  // Loop dari baris ke-2 (index 1)
  for (let i = 1; i < data.length; i++) {
    const rowUsername = String(data[i][0]).trim();
    const rowPassword = String(data[i][1]).trim();

    if (rowUsername === username.trim() && rowPassword === password.trim()) {
      return corsOutput({
        success : true,
        username: rowUsername,
        message : 'Login berhasil!'
      });
    }
  }

  return corsOutput({ success: false, error: 'Username atau password salah.' });
}

// ── Handler: Record Transaction ────────────────────────────────────
function recordTransaction(data) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet   = ss.getSheetByName(SHEET_TRANSAKSI);

  // Buat sheet jika belum ada
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TRANSAKSI);
    // Tambah header
    const headers = ['ID', 'Waktu', 'Jumlah Sesi', 'Extra Print', 'Total Bayar', 'Metode', 'Status'];
    sheet.appendRow(headers);

    // Format header: bold, warna latar belakang
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#FF3CAC');
    headerRange.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }

  // Siapkan data baris
  const row = [
    data.id        || '',                   // ID Transaksi
    data.timestamp || new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }), // Waktu
    data.sesi      || 0,                    // Jumlah Sesi
    data.print     || 0,                    // Extra Print
    data.total     || 0,                    // Total Bayar (angka, bukan string)
    data.method    || '',                   // Metode (Cash / QRIS)
    data.status    || 'Selesai',            // Status
  ];

  sheet.appendRow(row);

  // Format kolom Total Bayar sebagai mata uang Rupiah
  const lastRow  = sheet.getLastRow();
  const totalCol = 5; // Kolom E
  sheet.getRange(lastRow, totalCol).setNumberFormat('"Rp "#,##0');

  // Kembalikan nomor baris yang ditambahkan
  return lastRow;
}

// ── Utility: Setup Sheet (jalankan sekali dari Script Editor) ──────
/**
 * Jalankan fungsi ini SEKALI dari Script Editor (Run > setupSheets)
 * untuk membuat struktur sheet secara otomatis.
 */
function setupSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // ── Sheet Users ──
  let usersSheet = ss.getSheetByName(SHEET_USERS);
  if (!usersSheet) {
    usersSheet = ss.insertSheet(SHEET_USERS);
    Logger.log('Sheet "Users" berhasil dibuat.');
  }

  // Header
  const usersHeader = ['Username', 'Password'];
  usersSheet.getRange(1, 1, 1, usersHeader.length).setValues([usersHeader]);
  usersSheet.getRange(1, 1, 1, usersHeader.length).setFontWeight('bold').setBackground('#784BA0').setFontColor('#ffffff');
  usersSheet.setFrozenRows(1);

  // Contoh data user
  const existingData = usersSheet.getDataRange().getValues();
  if (existingData.length <= 1) {
    usersSheet.appendRow(['admin', 'bymoment123']);
    usersSheet.appendRow(['kasir1', 'kasir123']);
    Logger.log('Contoh data user ditambahkan.');
  }

  // ── Sheet Transaksi ──
  let trxSheet = ss.getSheetByName(SHEET_TRANSAKSI);
  if (!trxSheet) {
    trxSheet = ss.insertSheet(SHEET_TRANSAKSI);
    Logger.log('Sheet "Transaksi" berhasil dibuat.');
  }

  const trxHeader = ['ID', 'Waktu', 'Jumlah Sesi', 'Extra Print', 'Total Bayar', 'Metode', 'Status'];
  trxSheet.getRange(1, 1, 1, trxHeader.length).setValues([trxHeader]);
  trxSheet.getRange(1, 1, 1, trxHeader.length).setFontWeight('bold').setBackground('#FF3CAC').setFontColor('#ffffff');
  trxSheet.setFrozenRows(1);

  // Auto-resize kolom
  trxSheet.autoResizeColumns(1, trxHeader.length);

  Logger.log('✅ Setup selesai! Semua sheet sudah siap.');
  SpreadsheetApp.getUi().alert('✅ Setup berhasil! Sheet "Users" dan "Transaksi" sudah siap digunakan.');
}

// ── Utility: Test Login (jalankan dari Script Editor untuk uji coba) ──
function testLogin() {
  const result = handleLogin('admin', 'bymoment123');
  Logger.log(result.getContent());
}

// ── Utility: Test Record Transaction ─────────────────────────────
function testRecordTransaction() {
  const testData = {
    id        : 'TRX-TEST001',
    timestamp : new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
    sesi      : 2,
    print     : 1,
    total     : 60000,
    method    : 'Cash',
    status    : 'Selesai',
  };
  const rowNum = recordTransaction(testData);
  Logger.log('✅ Transaksi test berhasil dicatat di baris: ' + rowNum);
}
