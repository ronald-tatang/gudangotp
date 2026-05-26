const axios  = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url  : process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ── DOKU ────────────────────────────────────────────────────
const DOKU_CLIENT_ID  = process.env.DOKU_CLIENT_ID  || 'BRN-0237-1777463752367';
const DOKU_SECRET_KEY = process.env.DOKU_SECRET_KEY || 'SK-wGd4nsgWHODTAyM8Yfow';
const DOKU_BASE       = 'https://api.doku.com';

function dokuSign(requestId, timestamp, body) {
  const component = `${DOKU_CLIENT_ID}:${requestId}:${timestamp}:${body}`;
  return 'HMACSHA256=' + crypto.createHmac('sha256', DOKU_SECRET_KEY).update(component).digest('base64');
}
function dokuHeaders(rid, ts, body) {
  return {
    'Content-Type'      : 'application/json',
    'Client-Id'         : DOKU_CLIENT_ID,
    'Request-Id'        : rid,
    'Request-Timestamp' : ts,
    'Signature'         : dokuSign(rid, ts, body),
  };
}
function nowTs() { return new Date().toISOString().replace(/\.\d{3}Z$/, ''); }
function rid()   { return crypto.randomBytes(16).toString('hex'); }

async function getBalance(userId) {
  const bal = await kv.get(`wallet:${userId}:balance`);
  return parseInt(bal || 0);
}
async function setBalance(userId, amount) {
  await kv.set(`wallet:${userId}:balance`, amount);
}
async function addTransaction(userId, tx) {
  await kv.lpush(`wallet:${userId}:txs`, JSON.stringify({ ...tx, createdAt: Date.now() }));
  await kv.ltrim(`wallet:${userId}:txs`, 0, 99);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const userId = req.headers['x-user-id'] || req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'x-user-id header wajib' });

  try {
    if (action === 'balance') {
      const balance = await getBalance(userId);
      return res.json({ userId, balance });
    }

    if (action === 'history') {
      const txs = await kv.lrange(`wallet:${userId}:txs`, 0, 49);
      const parsed = txs.map(t => typeof t === 'string' ? JSON.parse(t) : t);
      return res.json({ userId, transactions: parsed });
    }

    if (action === 'topup' && req.method === 'POST') {
      const { amount, channel, customerName, customerEmail } = req.body || {};
      if (!amount || amount < 5000)
        return res.status(400).json({ error: 'Minimal top up Rp5.000' });

      const orderId = `TOPUP-${userId.substring(0, 12)}-${Date.now()}`;
      const ch      = channel || 'MANDIRI_VA';
      const isQris  = ch === 'QRIS';

      const bodyMap = isQris
        ? {
            order: {
              invoice_number: orderId,
              line_items: [{ name: 'Top Up Saldo VIRNOM', price: parseInt(amount), quantity: 1 }],
              amount  : parseInt(amount),
              currency: 'IDR',
            },
            customer: {
              name : customerName  || 'Pengguna VIRNOM',
              email: customerEmail || 'user@virnom.app',
            },
            additional_info: { type: 'QR_CODE' },
          }
        : {
            order: {
              invoice_number: orderId,
              line_items: [{ name: 'Top Up Saldo VIRNOM', price: parseInt(amount), quantity: 1 }],
              amount    : parseInt(amount),
              currency  : 'IDR',
              session_id: orderId,
            },
            virtual_account_info: {
              billing_type   : 'FIX_BILL',
              expired_time   : 60,
              reusable_status: false,
              info1          : 'Top Up Saldo VIRNOM',
            },
            customer: {
              name : customerName  || 'Pengguna VIRNOM',
              email: customerEmail || 'user@virnom.app',
            },
          };

      const bodyStr = JSON.stringify(bodyMap);
      const r = rid(), ts = nowTs();
      const endpoint = isQris
        ? `${DOKU_BASE}/qris/v2/payment`
        : `${DOKU_BASE}/virtual-accounts/${ch}/payment`;

      const { data } = await axios.post(endpoint, bodyStr, { headers: dokuHeaders(r, ts, bodyStr) });

      let responsePayload;
      if (isQris) {
        const qr = data.qr || {};
        responsePayload = { orderId, qrString: qr.qr_string || '', qrUrl: qr.qr_url || '', amount: parseInt(amount), type: 'QRIS' };
      } else {
        const vaInfo = data.virtual_account_info || {};
        responsePayload = { orderId, vaNumber: vaInfo.virtual_account_number || '', bank: ch.replace('_VA', ''), amount: parseInt(amount), expiredAt: vaInfo.expired_date || '', type: 'VA' };
      }

      await kv.set(`topup:${orderId}`, JSON.stringify({ userId, amount: parseInt(amount), status: 'pending' }), { ex: 7200 });
      return res.json(responsePayload);
    }

    if (action === 'topup_status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

      const r = rid(), ts = nowTs();
      const { data } = await axios.get(
        `${DOKU_BASE}/orders/${orderId}/status`,
        { headers: dokuHeaders(r, ts, '') }
      );

      const status = (data.transaction?.status || '').toUpperCase();
      const paid   = status === 'SUCCESS';

      if (paid) {
        const done = await kv.get(`topup:${orderId}:done`);
        if (!done) {
          const raw    = await kv.get(`topup:${orderId}`);
          const record = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
          const amount = record.amount || parseInt(data.order?.amount || 0);
          const cur    = await getBalance(userId);
          await setBalance(userId, cur + amount);
          await addTransaction(userId, { type: 'topup', orderId, amount, description: 'Top Up Saldo', status: 'success' });
          await kv.set(`topup:${orderId}:done`, '1', { ex: 86400 * 30 });
        }
      }

      const balance = await getBalance(userId);
      return res.json({ orderId, paid, status, amount: data.order?.amount, balance });
    }

    if (action === 'deduct' && req.method === 'POST') {
      const { amount, description, ref } = req.body || {};
      if (!amount) return res.status(400).json({ error: 'amount wajib' });
      const balance = await getBalance(userId);
      if (balance < amount) return res.status(402).json({ error: 'Saldo tidak cukup', balance, required: amount });
      await setBalance(userId, balance - amount);
      await addTransaction(userId, { type: 'deduct', ref, amount: -amount, description: description || 'Pembelian Nomor OTP', status: 'success' });
      return res.json({ success: true, balance: balance - amount });
    }

    if (action === 'refund' && req.method === 'POST') {
      const { amount, description, ref } = req.body || {};
      if (!amount) return res.status(400).json({ error: 'amount wajib' });
      const balance = await getBalance(userId);
      await setBalance(userId, balance + amount);
      await addTransaction(userId, { type: 'refund', ref, amount, description: description || 'Refund OTP Gagal', status: 'success' });
      return res.json({ success: true, balance: balance + amount });
    }

    return res.status(404).json({ error: 'Action tidak dikenal' });
  } catch (e) {
    const msg = e.response?.data?.error_messages?.[0] || e.response?.data?.status_message || e.message;
    return res.status(500).json({ error: msg });
  }
};
