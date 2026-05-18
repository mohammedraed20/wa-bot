// wa-bot/index.js — Railway
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const axios   = require('axios');
const qrcode  = require('qrcode');
const fs      = require('fs');
const path    = require('path');

const PORT       = process.env.PORT      || 3001;
const PHP_CHAT   = process.env.PHP_CHAT  || '';
const SECRET_KEY = process.env.WA_SECRET || 'wa_secret_2025';
// AUTH_DIR: use Railway Volume path if set, otherwise local (lost on restart)
const AUTH_DIR   = process.env.AUTH_DIR  || path.join(__dirname, 'auth_info');

let currentQR   = null;
let isConnected = false;
let waSocket    = null;
let phoneNum    = '';
let connecting  = false;
const sessions  = {};

const app = express();
app.use(express.json());

function authMW(req, res, next) {
  const k = req.headers['x-wa-secret'] || req.query.secret;
  if (k !== SECRET_KEY) return res.status(401).json({ error:'unauthorized' });
  next();
}

// Health check
app.get('/', (req, res) => res.json({ ok:true, connected:isConnected, phone:phoneNum, hasQR:!!currentQR }));

// Status
app.get('/status', authMW, (req, res) => {
  res.json({ connected:isConnected, phone:phoneNum, hasQR:!!currentQR });
});

// QR
app.get('/qr', authMW, (req, res) => {
  if (isConnected) return res.json({ connected:true, qr:null });
  if (!currentQR) {
    if (!connecting) connect();
    return res.json({ connected:false, qr:null, waiting:true });
  }
  res.json({ connected:false, qr:currentQR });
});

// Logout + reconnect
app.post('/logout', authMW, async (req, res) => {
  console.log('[Bot] Logout requested');
  isConnected = false; currentQR = null; phoneNum = '';

  if (waSocket) {
    try { await waSocket.logout(); } catch(e){}
    try { waSocket.end(); } catch(e){}
    waSocket = null;
  }

  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive:true, force:true });
  }

  res.json({ ok:true });
  setTimeout(connect, 1000);
});

// Send message
app.post('/send', authMW, async (req, res) => {
  const { to, message } = req.body;
  if (!isConnected || !waSocket) return res.status(503).json({ error:'not_connected' });
  if (!to || !message) return res.status(400).json({ error:'missing_params' });
  try {
    const jid = to.includes('@') ? to : to + '@s.whatsapp.net';
    await waSocket.sendMessage(jid, { text:message });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.listen(PORT, () => console.log(`[Bot] Port ${PORT}`));

// ── Baileys Connect ───────────────────────────────────────────
async function connect() {
  if (connecting) return;
  connecting = true;
  console.log('[Bot] Connecting... AUTH_DIR:', AUTH_DIR);

  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive:true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version, auth:state,
      printQRInTerminal: true,
      browser: ['AI Consultant','Chrome','3.0'],
      getMessage: async () => ({ conversation:'' }),
    });

    waSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('[Bot] QR ready');
        currentQR   = await qrcode.toDataURL(qr);
        isConnected = false;
        connecting  = false;
      }

      if (connection === 'close') {
        isConnected = false;
        connecting  = false;
        currentQR   = null;

        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode : 0;

        console.log(`[Bot] Disconnected. Code: ${code}`);

        if (code === DisconnectReason.loggedOut) {
          if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive:true, force:true });
          console.log('[Bot] Logged out — regenerating QR...');
          setTimeout(connect, 2000);
        } else if (code !== 401) {
          console.log('[Bot] Reconnecting in 5s...');
          setTimeout(connect, 5000);
        }
      }

      if (connection === 'open') {
        isConnected = true;
        currentQR   = null;
        connecting  = false;
        phoneNum    = waSocket.user?.id?.split(':')[0] || '';
        console.log(`[Bot] Connected! Phone: ${phoneNum}`);
      }
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        if (msg.key.remoteJid?.endsWith('@g.us')) continue;
        if (msg.key.remoteJid?.endsWith('@newsletter')) continue; // تجاهل القنوات

        const from     = msg.key.remoteJid;
        const phone    = from?.replace('@s.whatsapp.net','') || '';
        const pushName = msg.pushName || phone;
        const text     = msg.message?.conversation
                      || msg.message?.extendedTextMessage?.text
                      || msg.message?.imageMessage?.caption
                      || '';

        if (!text?.trim() || !PHP_CHAT) continue;
        console.log(`[Bot] ${phone} (${pushName}): ${text.substring(0,50)}`);

        if (!sessions[phone]) sessions[phone] = { conv_id:'' };
        const sess = sessions[phone];

        try { await waSocket.sendPresenceUpdate('composing', from); } catch(e){}

        try {
          const r = await axios.post(PHP_CHAT, {
            message: text,
            phone:   phone,       // ✅ رقم العميل
            name:    pushName,    // ✅ اسم العميل
            source:  'whatsapp',
            conv_id: sess.conv_id,
            id:      msg.key.id,  // ✅ deduplication
          }, {
            timeout: 35000,
            headers: {
              'Content-Type':  'application/json',
              'x-wa-secret':   SECRET_KEY,  // ✅ المفتاح — هذا كان السبب الرئيسي للـ 403
            }
          });

          const reply = r.data?.reply;
          if (!reply) { console.log('[Bot] No reply from PHP'); continue; }
          if (r.data?.conv_id) sess.conv_id = r.data.conv_id;

          await waSocket.sendMessage(from, { text:reply });
          console.log(`[Bot] Replied to ${phone}`);

        } catch(e) {
          console.error('[Bot] Error:', e.message);
          try { await waSocket.sendMessage(from, { text:'عذراً، حدث خطأ مؤقت. يرجى إعادة المحاولة.' }); } catch(e2){}
        }

        try { await waSocket.sendPresenceUpdate('paused', from); } catch(e){}
      }
    });

  } catch(e) {
    connecting = false;
    console.error('[Bot] Connect error:', e.message);
    setTimeout(connect, 8000);
  }
}

// بدء الاتصال عند التشغيل
connect();
