// wa-bot/index.js — يعمل على Railway
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
const AUTH_DIR   = path.join(__dirname, 'auth_info');

let currentQR = null, isConnected = false, waSocket = null, phoneNum = '';
const sessions = {};

const app = express();
app.use(express.json());

function auth(req, res, next) {
  if ((req.headers['x-wa-secret'] || req.query.secret) !== SECRET_KEY)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/',        (req, res) => res.json({ ok: true, connected: isConnected, phone: phoneNum }));
app.get('/status',  auth, (req, res) => res.json({ connected: isConnected, phone: phoneNum, hasQR: !!currentQR }));
app.get('/qr',      auth, (req, res) => {
  if (isConnected) return res.json({ connected: true, qr: null });
  res.json({ connected: false, qr: currentQR, waiting: !currentQR });
});
app.post('/logout', auth, async (req, res) => {
  if (waSocket) try { await waSocket.logout(); } catch(e){}
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  isConnected = false; currentQR = null; phoneNum = '';
  res.json({ ok: true });
});
app.post('/send', auth, async (req, res) => {
  const { to, message } = req.body;
  if (!isConnected || !waSocket) return res.status(503).json({ error: 'not_connected' });
  try {
    await waSocket.sendMessage(to.includes('@') ? to : to + '@s.whatsapp.net', { text: message });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`[Bot] Running on port ${PORT}`));

async function connect() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  waSocket = makeWASocket({ version, auth: state, printQRInTerminal: true, browser: ['AI Consultant','Chrome','3.0'], getMessage: async()=>({conversation:''}) });
  waSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = await qrcode.toDataURL(qr); isConnected = false; }
    if (connection === 'close') {
      isConnected = false; currentQR = null;
      const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
      if (code !== DisconnectReason.loggedOut) setTimeout(connect, 3000);
      else if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive:true, force:true });
    }
    if (connection === 'open') { isConnected = true; currentQR = null; phoneNum = waSocket.user?.id?.split(':')[0]||''; console.log(`[Bot] Connected: ${phoneNum}`); }
  });
  waSocket.ev.on('creds.update', saveCreds);
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid.endsWith('@g.us')) continue;
      const from  = msg.key.remoteJid;
      const phone = from.replace('@s.whatsapp.net','');
      const text  = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
      if (!text.trim() || !PHP_CHAT) continue;
      if (!sessions[phone]) sessions[phone] = { history:[], conv_id:'' };
      const sess = sessions[phone];
      try { await waSocket.sendPresenceUpdate('composing', from); } catch(e){}
      try {
        const r = await axios.post(PHP_CHAT, { message:text, history:sess.history.slice(-10), conv_id:sess.conv_id, source:'whatsapp', visitor_name:phone }, { timeout:30000 });
        const reply = r.data?.reply || 'عذراً، النظام مشغول.';
        if (r.data?.conv_id) sess.conv_id = r.data.conv_id;
        sess.history.push({role:'user',content:text},{role:'assistant',content:reply});
        if (sess.history.length > 20) sess.history = sess.history.slice(-20);
        await waSocket.sendMessage(from, { text: reply });
      } catch(e) { try { await waSocket.sendMessage(from, { text:'عذراً، النظام مشغول.' }); } catch(e2){} }
      try { await waSocket.sendPresenceUpdate('paused', from); } catch(e){}
    }
  });
}
connect().catch(console.error);
