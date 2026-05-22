const axios = require('axios');

const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const BASE_URL = 'https://api.midtrans.com/v2'; // production
// const BASE_URL = 'https://api.sandbox.midtrans.com/v2'; // sandbox

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'create';

  try {
    // ── CREATE QRIS TRANSACTION ───────────────────────────
    if (action === 'create' && req.method === 'POST') {
      const { amount, orderId, description } = req.body || {};

      if (!amount || !orderId) {
        return res.status(400).json({ error: 'amount dan orderId wajib diisi' });
      }

      const auth = Buffer.from(SERVER_KEY + ':').toString('base64');

      const payload = {
        payment_type: 'qris',
        transaction_details: {
          order_id: orderId,
          gross_amount: parseInt(amount)
        },
        qris: {
          acquirer: 'gopay'
        },
        item_details: [{
          id: 'otp-number',
          price: parseInt(amount),
          quantity: 1,
          name: description || 'Nomor OTP'
        }]
      };

      const { data } = await axios.post(`${BASE_URL}/charge`, payload, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      });

      // Ambil URL QR dari response Midtrans
      const qrUrl = data.actions?.find(a => a.name === 'generate-qr-code')?.url || null;

      return res.json({
        orderId: data.order_id,
        transactionId: data.transaction_id,
        qrUrl,
        amount: data.gross_amount,
        status: data.transaction_status,
        expiry: data.expiry_time
      });
    }

    // ── CHECK STATUS TRANSAKSI ────────────────────────────
    if (action === 'status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

      const auth = Buffer.from(SERVER_KEY + ':').toString('base64');
      const { data } = await axios.get(`${BASE_URL}/${orderId}/status`, {
        headers: { 'Authorization': `Basic ${auth}` }
      });

      const paid =
        data.transaction_status === 'settlement' ||
        data.transaction_status === 'capture';

      return res.json({
        orderId: data.order_id,
        status: data.transaction_status,
        paid,
        amount: data.gross_amount
      });
    }

    return res.status(404).json({ error: 'Action tidak dikenal' });

  } catch (e) {
    const msg = e.response?.data?.status_message || e.message;
    return res.status(500).json({ error: msg });
  }
};
