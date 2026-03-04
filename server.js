const express  = require('express');
const cors     = require('cors');
const XLSX     = require('xlsx');
const multer   = require('multer');
const QRCode   = require('qrcode');
const pino     = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs       = require('fs');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT   = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.options('*', cors());
app.use(express.json());

let sock       = null;
let qrCodeData = null;
let isReady    = false;
const AUTH_DIR = './auth_info';
const sleep    = ms => new Promise(r => setTimeout(r, ms));

async function initBaileys() {
  console.log('🔄 Baileys shuru ho raha hai...');
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds }       = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest }      = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys version: ${version.join('.')}, latest: ${isLatest}`);

  sock = makeWASocket({
    version,
    auth:              state,
    printQRInTerminal: false,
    logger:            pino({ level: 'silent' }),
    browser:           ['Trade Bridge', 'Chrome', '1.0.0'],
    connectTimeoutMs:  60000,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrCodeData = await QRCode.toDataURL(qr);
        isReady    = false;
        console.log('📱 QR Code ready!');
      } catch(e) { console.error('QR error:', e); }
    }

    if (connection === 'close') {
      isReady    = false;
      qrCodeData = null;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('❌ Connection closed, code:', code);

      if (code === DisconnectReason.loggedOut) {
        console.log('📱 Logged out — restarting...');
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
      }
      setTimeout(initBaileys, 5000);
    }

    if (connection === 'open') {
      isReady    = true;
      qrCodeData = null;
      console.log('✅ WhatsApp connected!');
    }
  });
}

function buildMessage(row) {
  return `Hello! 👋\n\nWe tried reaching you via call and WhatsApp, but couldn't get a response.\nAs a result, your order is now marked as delivered.\n\n📦 *Delivery Details:*\n🏢 *Organization:* ${row['Organization']||'N/A'}\n🧾 *Invoice ID:*   ${row['Invoice ID']||'N/A'}\n🛒 *Product:*      ${row['Product']||'N/A'}\n📦 *Quantity:*     ${row['Quantity']||'N/A'}\n🚚 *Transport:*    ${row['Transport Name']||'N/A'}\n📅 *Delivery Date:*${row['Delivery Date']||'N/A'}\n\nOur team will resolve any issues promptly. 🛠️\n\nThank you for choosing Trade Bridge!`;
}

app.get('/',       (req, res) => res.json({ status: isReady ? '✅ Connected!' : '⏳ Connecting...', ready: isReady, hasQR: !!qrCodeData }));
app.get('/status', (req, res) => res.json({ ready: isReady, hasQR: !!qrCodeData }));
app.get('/qr',     (req, res) => {
  if (isReady)     return res.json({ status: 'connected' });
  if (!qrCodeData) return res.json({ status: 'waiting' });
  res.json({ status: 'qr', qr: qrCodeData });
});

app.post('/send', upload.single('file'), async (req, res) => {
  if (!isReady)  return res.status(400).json({ error: '⚠️ WhatsApp connected nahi! Pehle QR scan karo.' });
  if (!req.file) return res.status(400).json({ error: 'Excel file nahi mili!' });

  const cc = req.body.countryCode || '91';
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    console.log(`📋 ${rows.length} customers`);
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row   = rows[i];
      const name  = String(row['Organization'] || `Customer ${i+1}`);
      const phone = String(row['Contact'] || '').replace(/\D/g, '');

      if (!phone || phone.length < 8) {
        results.push({ name, status: 'skipped', reason: 'Phone nahi mila' });
        continue;
      }

      const full = phone.startsWith(cc) ? `${phone}@s.whatsapp.net` : `${cc}${phone}@s.whatsapp.net`;
      console.log(`📤 ${name} → ${full}`);

      try {
        await sock.sendMessage(full, { text: buildMessage(row) });
        results.push({ name, phone: full, status: 'sent' });
        console.log(`✅ Sent!`);
      } catch(err) {
        results.push({ name, phone: full, status: 'failed', error: err.message });
        console.log(`❌ Failed: ${err.message}`);
      }

      if (i < rows.length - 1) await sleep(Math.floor(Math.random() * 2000) + 3000);
    }

    const sent    = results.filter(r => r.status === 'sent').length;
    const failed  = results.filter(r => r.status === 'failed').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    res.json({ results, summary: { total: rows.length, sent, failed, skipped } });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server port ${PORT} par!`);
  initBaileys();
});
