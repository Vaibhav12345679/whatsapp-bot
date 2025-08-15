// bot.mjs
import 'dotenv/config';
import express from 'express';
import open from 'open';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import pkg from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = pkg;

/* =========================
   CONFIG (from .env)
   ========================= */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const BUCKET_NAME = process.env.BUCKET_NAME || 'pdf-notes';
const GROUP_JID = process.env.GROUP_JID; // like 1203...@g.us

const POLL_MS = Number(process.env.POLL_MS || 10000);
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const QR_PORT = Number(process.env.QR_PORT || 3000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}
if (!GROUP_JID) {
  console.error('❌ Missing GROUP_JID (WhatsApp group JID) in .env');
  process.exit(1);
}

/* =========================
   Supabase client
   ========================= */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* =========================
   Simple QR Web Server
   ========================= */
const app = express();
let latestQRDataURL = '';

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>WhatsApp Login</title>
        <style>
          body { font-family: system-ui, Arial; display:flex; min-height:100vh; align-items:center; justify-content:center; background:#0b132b; color:#fff; }
          .card { background:#1c2541; padding:24px; border-radius:16px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); text-align:center; }
          img { width: 320px; height: 320px; background:#fff; padding:10px; border-radius:12px; }
          h1 { margin:0 0 8px; font-size:22px; }
          p { opacity:0.8; margin: 0 0 16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Scan to Login WhatsApp</h1>
          <p>Open WhatsApp → Linked devices → Link a device</p>
          ${latestQRDataURL ? `<img src="${latestQRDataURL}" alt="QR Code" />` : '<p>Waiting for QR...</p>'}
        </div>
      </body>
    </html>
  `;
  res.end(html);
});

const server = app.listen(QR_PORT, () => {
  console.log(`🧩 QR page on http://localhost:${QR_PORT}`);
});

/* =========================
   Helpers: sent cache
   ========================= */
const SENT_CACHE_FILE = path.resolve('./sent_cache.json');
function loadSentCache() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SENT_CACHE_FILE, 'utf8')));
  } catch (_) {
    return new Set();
  }
}
function saveSentCache(set) {
  try {
    fs.writeFileSync(SENT_CACHE_FILE, JSON.stringify([...set], null, 2));
  } catch (e) {
    console.warn('Could not save sent cache:', e.message);
  }
}
const sentFiles = loadSentCache();

/* =========================
   WhatsApp connection
   ========================= */
async function startWhatsApp() {
  // Ensure auth dir exists
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false, // we'll show QR in browser instead
    browser: ['Baileys', 'Chrome', '4.0.0'],
    auth: state
  });

  // Show QR in browser
  let openedBrowser = false;
  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      latestQRDataURL = await QRCode.toDataURL(qr);
      if (!openedBrowser) {
        openedBrowser = true;
        await open(`http://localhost:${QR_PORT}`);
      }
      // also refresh live page automatically after 1s (browser will re-request /)
      // (nothing extra needed, page pulls latest when reloaded)
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected.');
      latestQRDataURL = ''; // clear from page
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.status || 0;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.warn('⚠️ Connection closed', code, 'reconnect:', shouldReconnect);
      if (shouldReconnect) startWhatsApp();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Listen for incoming messages → save to Supabase (optional)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        const from = m.key.remoteJid || '';
        const to = sock.user?.id || '';
        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          '';

        if (!text) continue;

        await supabase.from('messages_inbox').insert({
          from_jid: from,
          to_jid: to,
          message: text,
          received_at: new Date().toISOString()
        });
      } catch (e) {
        console.warn('Inbox insert failed:', e.message);
      }
    }
  });

  // MAIN LOGIC A: poll Supabase Storage bucket for new PDFs
  async function pollBucketAndSend() {
    try {
      const { data, error } = await supabase
        .storage
        .from(BUCKET_NAME)
        .list('', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });

      if (error) {
        console.error('Storage list error:', error.message || error);
        return;
      }

      for (const file of data || []) {
        if (!file.name?.toLowerCase().endsWith('.pdf')) continue;
        if (sentFiles.has(file.name)) continue;

        const { data: pub, error: pubErr } = await supabase
          .storage
          .from(BUCKET_NAME)
          .getPublicUrl(file.name);

        if (pubErr) {
          console.error('Get public URL error:', pubErr.message || pubErr);
          continue;
        }

        const publicUrl = pub?.publicUrl;
        if (!publicUrl) continue;

        const text = `📄 New PDF uploaded:*${file.name}*\n${publicUrl}`;
        console.log('➡️ Sending to group:', file.name, publicUrl);
        await sock.sendMessage(GROUP_JID, { text });

        sentFiles.add(file.name);
        saveSentCache(sentFiles);
      }
    } catch (e) {
      console.error('pollBucketAndSend failed:', e.message);
    }
  }

  // MAIN LOGIC B (optional): send from messages_outbox table
  async function pollOutboxAndSend() {
    try {
      const { data, error } = await supabase
        .from('messages_outbox')
        .select('*')
        .is('sent_at', null)
        .limit(50);

      if (error) {
        // table may not exist; ignore quietly
        return;
      }

      for (const row of data || []) {
        const to = row.to || GROUP_JID;
        const message = row.message || '';
        if (!message) continue;

        const res = await sock.sendMessage(to, { text: message });
        await supabase
          .from('messages_outbox')
          .update({
            sent_at: new Date().toISOString(),
            wa_msg_id: res?.key?.id || null
          })
          .eq('id', row.id);
      }
    } catch (e) {
      console.warn('pollOutboxAndSend failed:', e.message);
    }
  }

  // Start polling loops
  setInterval(pollBucketAndSend, POLL_MS);
  setInterval(pollOutboxAndSend, POLL_MS);

  // Run immediately once
  pollBucketAndSend();
  pollOutboxAndSend();
}

// Kick off
startWhatsApp().catch((e) => {
  console.error('Fatal error starting bot:', e);
  process.exit(1);
});

// Graceful exit
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  server.close(() => process.exit(0));
});

