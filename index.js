import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import readline from 'readline';
import qrcode from 'qrcode-terminal';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

process.on('uncaughtException', (e) => console.error('[CRASH-CAUGHT]', new Date().toISOString(), e));
process.on('unhandledRejection', (e) => console.error('[REJECT-CAUGHT]', new Date().toISOString(), e));

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = baileys;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(__dirname, 'session');
const DB_PRODUK = path.join(__dirname, 'db', 'produk.json');
const DB_ORDERS = path.join(__dirname, 'db', 'orders.json');
const CONFIG = path.join(__dirname, 'config.json');

let config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const { owner, storename, prefix } = config;

function saveConfig() {
  writeFileSync(CONFIG, JSON.stringify(config, null, 2));
}

const logger = pino({ level: 'silent' });

function loadDB(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
function saveDB(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function rupiah(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

function genOrderId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return 'ORD-' + id;
}

function isOwner(jid) {
  const num = jid.split('@')[0].split(':')[0];
  return owner.includes(num);
}

function stokCount(produk) {
  return Array.isArray(produk.stok) ? produk.stok.length : Number(produk.stok) || 0;
}

function waFormat(t) {
  if (!t) return t;
  return String(t)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/###?\s*/g, '')
    .replace(/```+/g, '');
}

async function callBellAI(text, senderId, senderName) {
  const produk = loadDB(DB_PRODUK);
  const produkList = Object.entries(produk)
    .map(
      ([kode, p]) =>
        `- ${p.nama} (kode: ${kode}, harga: ${rupiah(p.harga)}, stok: ${stokCount(p)}, tipe: ${p.tipe})${p.deskripsi ? ' — ' + p.deskripsi : ''}`
    )
    .join('\n');

  const jamOperasi = config.jam_operasi || '08:00 - 22:00';
  const customProfile =
    `${config.logic}\n\n` +
    `Jam operasional toko: ${jamOperasi} WIB.\n\n` +
    `Daftar produk yang tersedia:\n${produkList || '(belum ada produk)'}\n\n` +
    `Prefix command untuk order: ${prefix}beli <kode> <jumlah>\n\n` +
    `PENTING: Jangan gunakan format markdown **teks** untuk bold. Gunakan format WhatsApp *teks* (satu tanda bintang saja) jika ingin menebalkan teks.`;

  const res = await fetch(`${config.api.url}/api/chat/logic-bell?key=${config.api.key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      text,
      id: senderId,
      fullainame: config.botname,
      nickainame: config.botname,
      senderName,
      ownerName: 'Owner',
      role: 'user',
      chatCount: 0,
      date: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
      custom_profile: customProfile,
    }),
  });
  const data = await res.json();
  return data?.data?.msg || data?.msg || null;
}

let sock;
let usePairing = false;
let firstRun = true;

async function connectBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION);

  if (firstRun && !existsSync(path.join(SESSION, 'creds.json'))) {
    firstRun = false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (t) => new Promise((res) => rl.question(t, res));
    console.log(
      chalk.yellow('\nBelum ada session. Pilih metode koneksi:') +
        chalk.blue('\n  ▪︎ qr\n  ▪︎ pairing\n')
    );
    const opsi = await question(chalk.green('Ketik di sini: '));
    usePairing = opsi.trim().toLowerCase() === 'pairing';
    if (usePairing) {
      global._phone = await question(chalk.green('Masukkan nomor WhatsApp (contoh 62812xxxx): '));
    }
    rl.close();
  }
  firstRun = false;

  const version = [2, 3000, await fetch('https://raw.githubusercontent.com/Rifza123/Experimental-Bell/refs/heads/master/version').then(a => a.text())];

  sock = makeWASocket({
    logger,
    version,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: state,
  });

  if (usePairing && !sock.authState.creds.registered) {
    const phone = (global._phone || '').replace(/[^0-9]/g, '');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone);
        console.log(chalk.bold.green(`\nPairing Code: ${code}\n`));
      } catch (e) {
        console.error('Gagal request pairing code:', e.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !usePairing) {
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log(chalk.green(`\n✅ ${storename} terhubung!\n`));
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      console.log(chalk.red(`Koneksi terputus (${code}).`), reconnect ? 'Menyambung ulang...' : 'Logged out.');
      if (reconnect) connectBot();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        console.log('[UPSERV]', msg.key.remoteJid, 'fromMe:', !!msg.key.fromMe, '|', JSON.stringify(msg.message).slice(0, 80));
        await handleMessage(msg);
      } catch (e) {
        console.error('Handler error:', e);
      }
    }
  });
}

function getText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

async function handleMessage(msg) {
  if (!msg.message) return;
  const fromMe = !!msg.key.fromMe;
  const jid = msg.key.remoteJid;
  if (jid === 'status@broadcast') return;

  const meNumber = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
  let sender;
  if (fromMe) {
    sender = jid.endsWith('@s.whatsapp.net') ? jid : meNumber;
  } else {
    sender = msg.key.participant || jid;
  }
  const text = getText(msg).trim();
  if (!text) return;

    if (!text.startsWith(prefix)) {
      console.log('[AI-BRANCH] active:', config.ai_active, 'fromMe:', fromMe, '|', text.slice(0, 50));
      if (!config.ai_active || fromMe) return;

    const nowStr = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const jamNow = parseInt(nowStr.split('.')[0]);
    const [jamBuka, jamTutup] = (config.jam_operasi || '08:00 - 22:00')
      .split('-')
      .map((s) => parseInt(s));

    const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });

    if (jamNow < jamBuka || jamNow >= jamTutup) {
      return reply(
        `Maaf kak, toko sedang tutup. Jam operasional kami *${config.jam_operasi}* WIB. Silakan hubungi kami kembali ya 🙏`
      );
    }

    const pushName = msg.pushName || 'Kak';
    try {
      const aiReply = await callBellAI(text, sender, pushName);
      if (aiReply) return reply(waFormat(aiReply));
    } catch (e) {
      console.error('AI Error:', e.message);
    }
    return;
  }

  const args = text.slice(prefix.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();
  const argText = args.join(' ');

  const reply = (t, extra = {}) => sock.sendMessage(jid, { text: t, ...extra }, { quoted: msg });
  const owns = fromMe || isOwner(sender);

  switch (cmd) {
    case 'menu':
    case 'help':
      return reply(menuText(owns));

    case 'shop':
    case 'produk':
      return reply(shopText());

    case 'detail': {
      if (!argText) return reply(`Contoh: ${prefix}detail capcut1bln`);
      const produk = loadDB(DB_PRODUK);
      const p = produk[argText.toLowerCase()];
      if (!p) return reply('Produk tidak ditemukan. Ketik .shop untuk lihat daftar.');
      const caption =
        `📦 *${p.nama}*\n\n` +
        `🏷 Kode: ${argText.toLowerCase()}\n` +
        `💰 Harga: ${rupiah(p.harga)}\n` +
        `📊 Stok: ${stokCount(p)}\n` +
        `📁 Tipe: ${p.tipe}\n` +
        `📝 ${p.deskripsi || '-'}\n\n` +
        `Ketik *${prefix}beli ${argText.toLowerCase()} <jumlah>* untuk memesan.`;
      if (p.gambar) {
        return sock.sendMessage(jid, { image: { url: p.gambar }, caption }, { quoted: msg });
      }
      return reply(caption);
    }

    case 'beli': {
      const [kode, jml] = args;
      if (!kode) return reply(`Contoh: ${prefix}beli capcut1bln 1`);
      const jumlah = parseInt(jml) || 1;
      const produk = loadDB(DB_PRODUK);
      const p = produk[kode.toLowerCase()];
      if (!p) return reply('Produk tidak ditemukan. Ketik .shop untuk lihat daftar.');
      if (stokCount(p) < jumlah) return reply(`Stok tidak cukup. Sisa stok: ${stokCount(p)}`);

      const orders = loadDB(DB_ORDERS);
      const id = genOrderId();
      const total = p.harga * jumlah;
      orders[id] = {
        buyer: sender,
        item: kode.toLowerCase(),
        nama: p.nama,
        jumlah,
        total,
        status: 'pending',
        waktu: Date.now(),
      };
      saveDB(DB_ORDERS, orders);

      await reply(
        `✅ *Order Dibuat*\n\n` +
          `🧾 ID: *${id}*\n` +
          `📦 ${p.nama}\n` +
          `🔢 Jumlah: ${jumlah}\n` +
          `💰 Total: *${rupiah(total)}*\n\n` +
          `Status: ⏳ PENDING\n\n` +
          `Untuk membayar ketik:\n*${prefix}payment ${id}*`
      );

      for (const o of owner) {
        await sock.sendMessage(o + '@s.whatsapp.net', {
          text:
            `🔔 *Order Baru*\n\n` +
            `🧾 ID: ${id}\n` +
            `👤 Buyer: wa.me/${sender.split('@')[0]}\n` +
            `📦 ${p.nama} x${jumlah}\n` +
            `💰 ${rupiah(total)}\n\n` +
            `Konfirmasi: ${prefix}acc ${id}`,
        });
      }
      return;
    }

    case 'payment':
    case 'bayar': {
      if (!argText) return reply(`Contoh: ${prefix}payment ORD-XXXX`);
      const orders = loadDB(DB_ORDERS);
      const id = argText.toUpperCase();
      const o = orders[id];
      if (!o) return reply('Order tidak ditemukan.');
      if (o.buyer !== sender) return reply('Ini bukan order kamu.');
      if (o.status !== 'pending') return reply(`Order ini berstatus: ${o.status}`);

      const caption =
        `💳 *Pembayaran QRIS*\n\n` +
        `🧾 ID: ${id}\n` +
        `📦 ${o.nama} x${o.jumlah}\n` +
        `💰 Total: *${rupiah(o.total)}*\n\n` +
        `Scan QRIS di atas, lalu tunggu konfirmasi admin.`;

      const qrisPath = path.join(__dirname, 'qris.jpg');
      if (existsSync(qrisPath)) {
        return sock.sendMessage(jid, { image: { url: qrisPath }, caption }, { quoted: msg });
      }
      return reply(caption + '\n\n⚠️ (File QRIS belum tersedia)');
    }

    case 'orders':
    case 'pesanan': {
      const orders = loadDB(DB_ORDERS);
      const mine = Object.entries(orders).filter(([, o]) => o.buyer === sender);
      if (!mine.length) return reply('Kamu belum punya pesanan.');
      let t = '🧾 *Pesanan Kamu*\n\n';
      for (const [id, o] of mine) {
        t += `${id} — ${o.nama} x${o.jumlah}\n  ${rupiah(o.total)} • ${o.status}\n\n`;
      }
      return reply(t.trim());
    }

    case 'batal': {
      if (!argText) return reply(`Contoh: ${prefix}batal ORD-XXXX`);
      const orders = loadDB(DB_ORDERS);
      const id = argText.toUpperCase();
      const o = orders[id];
      if (!o) return reply('Order tidak ditemukan.');
      if (o.buyer !== sender) return reply('Ini bukan order kamu.');
      if (o.status !== 'pending') return reply('Order sudah diproses, tidak bisa dibatalkan.');
      delete orders[id];
      saveDB(DB_ORDERS, orders);
      return reply(`Order ${id} dibatalkan.`);
    }

    // ===== OWNER COMMANDS =====
    case 'addproduk': {
      if (!owns) return reply('Command khusus owner.');
      const parts = argText.split('|').map((s) => s.trim());
      if (parts.length < 5)
        return reply(`Format:\n${prefix}addproduk kode|nama|tipe|harga|stok|deskripsi\n\ntipe: fisik / digital`);
      const [kode, nama, tipe, harga, stok, deskripsi] = parts;
      const produk = loadDB(DB_PRODUK);
      produk[kode.toLowerCase()] = {
        nama,
        tipe: tipe.toLowerCase() === 'digital' ? 'digital' : 'fisik',
        harga: parseInt(harga) || 0,
        stok: tipe.toLowerCase() === 'digital' ? [] : parseInt(stok) || 0,
        deskripsi: deskripsi || '',
        gambar: '',
      };
      saveDB(DB_PRODUK, produk);
      return reply(`✅ Produk *${nama}* (${kode.toLowerCase()}) ditambahkan.`);
    }

    case 'delproduk': {
      if (!owns) return reply('Command khusus owner.');
      const produk = loadDB(DB_PRODUK);
      const kode = argText.toLowerCase();
      if (!produk[kode]) return reply('Produk tidak ditemukan.');
      delete produk[kode];
      saveDB(DB_PRODUK, produk);
      return reply(`Produk ${kode} dihapus.`);
    }

    case 'addstok': {
      if (!owns) return reply('Command khusus owner.');
      const kode = args.shift()?.toLowerCase();
      const nilai = args.join(' ');
      if (!kode || !nilai)
        return reply(
          `Format:\n- Digital: ${prefix}addstok netflix1bln email@mail.com|password\n- Fisik: ${prefix}addstok iphone15 5`
        );
      const produk = loadDB(DB_PRODUK);
      const p = produk[kode];
      if (!p) return reply('Produk tidak ditemukan.');
      if (p.tipe === 'digital') {
        if (!Array.isArray(p.stok)) p.stok = [];
        p.stok.push(nilai);
        saveDB(DB_PRODUK, produk);
        return reply(`✅ Stok akun ditambahkan ke ${kode}. Total stok: ${p.stok.length}`);
      } else {
        p.stok = (parseInt(p.stok) || 0) + (parseInt(nilai) || 0);
        saveDB(DB_PRODUK, produk);
        return reply(`✅ Stok ${kode} sekarang: ${p.stok}`);
      }
    }

    case 'listorder': {
      if (!owns) return reply('Command khusus owner.');
      const orders = loadDB(DB_ORDERS);
      const entries = Object.entries(orders);
      if (!entries.length) return reply('Belum ada order.');
      let t = '📋 *Semua Order*\n\n';
      for (const [id, o] of entries) {
        t += `${id} — ${o.nama} x${o.jumlah}\n  buyer: ${o.buyer.split('@')[0]}\n  ${rupiah(o.total)} • ${o.status}\n\n`;
      }
      return reply(t.trim());
    }

    case 'acc': {
      if (!owns) return reply('Command khusus owner.');
      const orders = loadDB(DB_ORDERS);
      const id = argText.toUpperCase();
      const o = orders[id];
      if (!o) return reply('Order tidak ditemukan.');
      if (o.status !== 'pending') return reply(`Order ini sudah berstatus: ${o.status}`);

      const produk = loadDB(DB_PRODUK);
      const p = produk[o.item];
      if (!p) return reply('Produk order ini sudah tidak ada.');
      if (stokCount(p) < o.jumlah) return reply(`Stok tidak cukup untuk acc. Sisa: ${stokCount(p)}`);

      let deliver = '';
      if (p.tipe === 'digital') {
        const akun = p.stok.splice(0, o.jumlah);
        deliver = akun.map((a, i) => `${i + 1}. ${a}`).join('\n');
      } else {
        p.stok = Number(p.stok) - o.jumlah;
      }
      o.status = 'success';
      saveDB(DB_PRODUK, produk);
      saveDB(DB_ORDERS, orders);

      if (p.tipe === 'digital') {
        await sock.sendMessage(o.buyer, {
          text:
            `✅ *Pembayaran Dikonfirmasi*\n\n` +
            `🧾 ${id} — ${p.nama} x${o.jumlah}\n\n` +
            `🔑 *Detail Akun:*\n${deliver}\n\n` +
            `Terima kasih sudah berbelanja! 🙏`,
        });
      } else {
        await sock.sendMessage(o.buyer, {
          text:
            `✅ *Pembayaran Dikonfirmasi*\n\n` +
            `🧾 ${id} — ${p.nama} x${o.jumlah}\n\n` +
            `Pesanan fisik kamu diproses. Admin akan menghubungi untuk pengiriman. 📦`,
        });
      }
      return reply(`✅ Order ${id} berhasil di-acc. Sisa stok ${o.item}: ${stokCount(p)}`);
    }

    case 'tolak': {
      if (!owns) return reply('Command khusus owner.');
      const orders = loadDB(DB_ORDERS);
      const id = argText.toUpperCase();
      const o = orders[id];
      if (!o) return reply('Order tidak ditemukan.');
      o.status = 'rejected';
      saveDB(DB_ORDERS, orders);
      await sock.sendMessage(o.buyer, {
        text: `❌ Order ${id} ditolak oleh admin. Silakan hubungi admin untuk info lebih lanjut.`,
      });
      return reply(`Order ${id} ditolak.`);
    }

    case 'aion': {
      if (!owns) return reply('Command khusus owner.');
      config.ai_active = true;
      saveConfig();
      return reply('✅ AI customer service diaktifkan.');
    }

    case 'aioff': {
      if (!owns) return reply('Command khusus owner.');
      config.ai_active = false;
      saveConfig();
      return reply('AI customer service dinonaktifkan.');
    }

    case 'setjam': {
      if (!owns) return reply('Command khusus owner.');
      if (!argText) return reply(`Contoh: ${prefix}setjam 09:00 - 21:00`);
      config.jam_operasi = argText;
      saveConfig();
      return reply(`✅ Jam operasi diubah ke: ${argText} WIB`);
    }

    default: {
      return;
    }
  }
}

function menuText(owns) {
  let t =
    `🛒 *${storename}*\n\n` +
    `*MENU PEMBELI*\n` +
    `${prefix}shop — lihat katalog\n` +
    `${prefix}detail <kode> — detail produk\n` +
    `${prefix}beli <kode> <jumlah> — pesan\n` +
    `${prefix}payment <id> — bayar (QRIS)\n` +
    `${prefix}orders — pesanan saya\n` +
    `${prefix}batal <id> — batalkan order\n`;
  if (owns) {
    t +=
      `\n*MENU OWNER*\n` +
      `${prefix}addproduk kode|nama|tipe|harga|stok|desk\n` +
      `${prefix}delproduk <kode>\n` +
      `${prefix}addstok <kode> <nilai>\n` +
      `${prefix}listorder\n` +
      `${prefix}acc <id> — konfirmasi bayar\n` +
      `${prefix}tolak <id>\n` +
      `${prefix}aion — aktifkan AI CS\n` +
      `${prefix}aioff — nonaktifkan AI CS\n` +
      `${prefix}setjam <jam> — ubah jam operasi\n`;
  }
  return t.trim();
}

function shopText() {
  const produk = loadDB(DB_PRODUK);
  const entries = Object.entries(produk);
  if (!entries.length) return 'Belum ada produk.';
  const fisik = entries.filter(([, p]) => p.tipe === 'fisik');
  const digital = entries.filter(([, p]) => p.tipe === 'digital');

  let t = `🛒 *KATALOG ${storename.toUpperCase()}*\n`;

  if (digital.length) {
    t += `\n💳 *PRODUK DIGITAL*\n`;
    for (const [kode, p] of digital) {
      t += `\n• *${p.nama}*\n  Kode: ${kode}\n  ${rupiah(p.harga)} • Stok: ${stokCount(p)}\n`;
    }
  }
  if (fisik.length) {
    t += `\n📱 *PRODUK FISIK*\n`;
    for (const [kode, p] of fisik) {
      t += `\n• *${p.nama}*\n  Kode: ${kode}\n  ${rupiah(p.harga)} • Stok: ${stokCount(p)}\n`;
    }
  }
  t += `\nKetik *${prefix}detail <kode>* untuk info lengkap.`;
  return t.trim();
}

connectBot();

process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
