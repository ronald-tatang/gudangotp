// api/wallet.js — Wallet + Top Up via CASHI.ID
// Env: CASHI_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN

const axios  = require('axios');
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url  : process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const CASHI_API_KEY = process.env.CASHI_API_KEY || 'CASHI-CFXQ470IQH5';
const BASE_URL      = 'https://cashi.id/api';

function cashiHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-key'   : CASHI_API_KEY,
  };
}

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

    // ── SALDO ─────────────────────────────────────────────
    if (action === 'balance') {
      const balance = await getBalance(userId);
      return res.json({ userId, balance });
    }

    // ── RIWAYAT ───────────────────────────────────────────
    if (action === 'history') {
      const txs    = await kv.lrange(`wallet:${userId}:txs`, 0, 49);
      const parsed = txs.map(t => typeof t === 'string' ? JSON.parse(t) : t);
      return res.json({ userId, transactions: parsed });
    }

    // ── TOP UP via CASHI.ID ───────────────────────────────
    if (action === 'topup' && req.method === 'POST') {
      const { amount, customerName } = req.body || {};
      if (!amount || amount < 2000)
        return res.status(400).json({ error: 'Minimal top up Rp2.000' });

      const orderId = `TOPUP-${userId.substring(0, 12)}-${Date.now()}`;

      const body = {
        amount  : parseInt(amount),
        order_id: orderId,
      };

      const { data } = await axios.post(`${BASE_URL}/create-order`, body, {
        headers: cashiHeaders(),
      });

      await kv.set(
        `topup:${orderId}`,
        JSON.stringify({ userId, amount: parseInt(amount), status: 'pending' }),
        { ex: 7200 }
      );

      return res.json({
        orderId,
        qrUrl    : data.qr_url   || data.qrUrl    || '',
        qrString : data.qr_code  || data.qrString  || '',
        amount   : parseInt(amount),
        expiredAt: data.expired_at || '',
        type     : 'QRIS',
      });
    }

    // ── CEK STATUS TOP UP ─────────────────────────────────
    if (action === 'topup_status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

      const { data } = await axios.get(`${BASE_URL}/check-status?order_id=${orderId}`, {
        headers: cashiHeaders(),
      });

      const status = (data.status || '').toUpperCase();
      const paid   = ['SUCCESS', 'PAID', 'SETTLEMENT', 'COMPLETED'].includes(status);

      if (paid) {
        const done = await kv.get(`topup:${orderId}:done`);
        if (!done) {
          const raw    = await kv.get(`topup:${orderId}`);
          const record = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
          const amount = record.amount || parseInt(data.amount || 0);
          const cur    = await getBalance(userId);
          await setBalance(userId, cur + amount);
          await addTransaction(userId, {
            type: 'topup', orderId, amount,
            description: 'Top Up Saldo via Cashi.id', status: 'success',
          });
          await kv.set(`topup:${orderId}:done`, '1', { ex: 86400 * 30 });
        }
      }

      const balance = await getBalance(userId);
      return res.json({ orderId, paid, status: data.status, amount: data.amount, balance });
    }

    // ── POTONG SALDO ──────────────────────────────────────
    if (action === 'deduct' && req.method === 'POST') {
      const { amount, description, ref } = req.body || {};
      if (!amount || amount <= 0)
        return res.status(400).json({ error: 'amount tidak valid' });

      const cur = await getBalance(userId);
      if (cur < amount)
        return res.status(400).json({ error: 'Saldo tidak cukup', balance: cur });

      await setBalance(userId, cur - amount);
      await addTransaction(userId, {
        type: 'deduct', amount, description: description || 'Pembelian', ref, status: 'success',
      });

      const balance = await getBalance(userId);
      return res.json({ success: true, userId, amount, balance });
    }

    return res.status(404).json({ error: 'Action tidak dikenal' });

  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    return res.status(500).json({ error: msg });
  }
};
