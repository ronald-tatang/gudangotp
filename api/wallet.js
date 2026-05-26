const axios = require('axios');
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const BASE_URL = 'https://api.midtrans.com';

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
      const { amount } = req.body || {};
      if (!amount || amount < 5000)
        return res.status(400).json({ error: 'Minimal top up Rp5.000' });

      const orderId = `TOPUP-${userId.substring(0,12)}-${Date.now()}`;
      const auth = Buffer.from(SERVER_KEY + ':').toString('base64');
      // Gunakan Snap API agar bisa dibuka di WebView dalam app
      const { data } = await axios.post(
        'https://app.midtrans.com/snap/v1/transactions',
        {
          transaction_details: { order_id: orderId, gross_amount: parseInt(amount) },
          item_details: [{ id: 'topup', price: parseInt(amount), quantity: 1, name: 'Top Up Saldo VIRNOM' }],
          enabled_payments: ['credit_card','bca_va','bni_va','bri_va','other_va','gopay','shopeepay','dana','ovo','qris','indomaret','alfamart'],
          expiry: { unit: 'minutes', duration: 30 },
          custom_field1: userId,
        },
        { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' } }
      );
      const paymentUrl = `https://app.midtrans.com/snap/v4/vtweb/${data.token}`;
      await kv.set(`topup:${orderId}`, JSON.stringify({ userId, amount: parseInt(amount), status: 'pending' }), { ex: 3600 });
      return res.json({ orderId, paymentUrl, amount: parseInt(amount) });
    }

    if (action === 'topup_status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });
      const auth = Buffer.from(SERVER_KEY + ':').toString('base64');
      const { data } = await axios.get(`${BASE_URL}/v2/${orderId}/status`,
        { headers: { 'Authorization': `Basic ${auth}` } });
      const paid = data.transaction_status === 'settlement' || data.transaction_status === 'capture';
      if (paid) {
        const done = await kv.get(`topup:${orderId}:done`);
        if (!done) {
          const amount = parseInt(data.gross_amount);
          const cur = await getBalance(userId);
          await setBalance(userId, cur + amount);
          await addTransaction(userId, { type: 'topup', orderId, amount, description: 'Top Up Saldo', status: 'success' });
          await kv.set(`topup:${orderId}:done`, '1', { ex: 86400 * 30 });
        }
      }
      const balance = await getBalance(userId);
      return res.json({ orderId, paid, status: data.transaction_status, amount: data.gross_amount, balance });
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
