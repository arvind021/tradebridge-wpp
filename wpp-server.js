const express    = require('express');
const cors       = require('cors');
const XLSX       = require('xlsx');
const multer     = require('multer');
const { create } = require('@wppconnect-team/wppconnect');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT   = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.options('*', cors());
app.use(express.json());

let wppClient  = null;
let qrCodeData = null;
let isReady    = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- WPPConnect Initialize ----
async function initWPP() {
  console.log('🔄 WPPConnect shuru ho raha hai...');
  try {
    wppClient = await create({
      session:          'tradebridge',
      catchQR:          (base64Qr) => {
        qrCodeData = base64Qr;
        isReady    = false;
        console.log('📱 QR Code ready — dashboard pe jaake scan karo!');
      },
      statusFind:       (status) => console.log('Status:', status),
      headless:         true,
      devtools:         false,
      useChrome:        false,
      debug:            false,
      logQR:            false,
      browserArgs:      [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      autoClose:        0,
      tokenStore:       'file',
    });

    isReady    = true;
    qrCodeData = null;
    console.log('✅ WhatsApp connected!');
  } catch(err) {
    console.error('❌ WPPConnect Error:', err.message);
    setTimeout(initWPP, 5000);
  }
}

// ---- ROUTES ----

// Health check
app.get('/', (req, res) => {
  res.json({
    status:  isReady ? '✅ WhatsApp Connected!' : '⏳ WhatsApp connecting...',
    ready:   isReady,
    hasQR:   !!qrCodeData
  });
});

// QR Code
app.get('/qr', (req, res) => {
  if (isReady) return res.json({ status: 'connected', message: '✅ Already connected!' });
  if (!qrCodeData) return res.json({ status: 'waiting', message: '⏳ QR generate ho raha hai...' });
  res.json({ status: 'qr', qr: qrCodeData });
});

// Status
app.get('/status', (req, res) => {
  res.json({ ready: isReady, hasQR: !!qrCodeData });
});

// Send Messages
app.post('/send', upload.single('file'), async (req, res) => {
  if (!isReady) return res.status(400).json({ error: '⚠️ WhatsApp connected nahi hai! Pehle QR scan karo.' });
  if (!req.file) return res.status(400).json({ error: 'Excel file nahi mili!' });

  const cc = req.body.countryCode || '91';

  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

    console.log(`📋 ${rows.length} customers mile`);
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row   = rows[i];
      const name  = String(row['Organization'] || `Customer ${i+1}`);
      const phone = String(row['Contact'] || '').replace(/\D/g, '');

      if (!phone || phone.length < 8) {
        console.log(`⚠️  ${name} — Skip!`);
        results.push({ name, status: 'skipped', reason: 'Phone nahi mila' });
        continue;
      }

      const full = phone.startsWith(cc) ? `${phone}@c.us` : `${cc}${phone}@c.us`;
      console.log(`📤 ${name} (${full}) ko bhej raha hoon...`);

      try {
        await wppClient.sendText(full, buildMessage(row));
        console.log(`✅ Bhej diya!`);
        results.push({ name, phone: full, status: 'sent' });
      } catch(err) {
        console.log(`❌ Error: ${err.message}`);
        results.push({ name, phone: full, status: 'failed', error: err.message });
      }

      // Random delay 3-5 seconds (ban se bachne ke liye)
      const delay = Math.floor(Math.random() * 2000) + 3000;
      if (i < rows.length - 1) await sleep(delay);
    }

    const sent    = results.filter(r => r.status === 'sent').length;
    const failed  = results.filter(r => r.status === 'failed').length;
    const skipped = results.filter(r => r.status === 'skipped').length;

    res.json({ results, summary: { total: rows.length, sent, failed, skipped } });

  } catch(err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- MESSAGE TEMPLATE ----
function buildMessage(row) {
  return `Hello! 👋

We tried reaching you via call and WhatsApp, but couldn't get a response.
As a result, your order is now marked as delivered.

📦 *Delivery Details:*
🏢 *Organization:* ${row['Organization']||'N/A'}
🛒 *Product:* ${row['Product']||'N/A'}
📦 *Quantity:* ${row['Quantity']||'N/A'}
🚚 *Transport:* ${row['Transport Name']||'N/A'}
📅 *Delivery Date:* ${row['Delivery Date']||'N/A'}

Our team will resolve any issues promptly. 🛠️

Thank you for choosing Trade Bridge!`;
}

// ---- START ----
app.listen(PORT, () => {
  console.log(`🚀 Server chal raha hai port ${PORT} par!`);
  initWPP();
});
