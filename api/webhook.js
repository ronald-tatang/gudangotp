const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const notif = req.body;
    const { order_id, status_code, gross_amount, signature_key } = notif;

    const expected = crypto.createHash('sha512')
      .update(`${order_id}${status_code}${gross_amount}${SERVER_KEY}`)
      .digest('hex');
    if (signature_key !== expected)
      return res.status(403).json({ error: 'Invalid signature' });

    const paid = notif.transaction_status === 'settlement' || notif.transaction_status === 'capture';
    if (!order_id.startsWith('TOPUP-')) return res.json({ message: 'Bukan transaksi top up, skip' });
    if (!paid) return res.json({ message: `Status ${notif.transaction_status}, skip` });

    const userId = notif.custom_field1 || order_id.split('-')[1];
    if (!userId) return res.status(400).json({ error: 'userId tidak ditemukan' });

    const done = await kv.get(`topup:${order_id}:done`);
    if (done) return res.json({ message: 'Sudah diproses' });

    const amount = parseInt(gross_amount);
    const cur = parseInt(await kv.get(`wallet:${userId}:balance`) || 0);
    await kv.set(`wallet:${userId}:balance`, cur + amount);
    await kv.lpush(`wallet:${userId}:txs`, JSON.stringify({
      type: 'topup', orderId: order_id, amount,
      description: 'Top Up Saldo via Midtrans',
      status: 'success', createdAt: Date.now()
    }));
    await kv.ltrim(`wallet:${userId}:txs`, 0, 99);
    await kv.set(`topup:${order_id}:done`, '1', { ex: 86400 * 30 });

    return res.json({ success: true, userId, amount, balance: cur + amount });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
