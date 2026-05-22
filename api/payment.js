const axios = require('axios');

// Midtrans Payment Link API
// Docs: https://docs.midtrans.com/reference/create-payment-link
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const BASE_URL = 'https://api.midtrans.com'; // production
// const BASE_URL = 'https://api.sandbox.midtrans.com'; // sandbox

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'create';

  try {

    // ── CREATE PAYMENT LINK ───────────────────────────────
    if (action === 'create' && req.method === 'POST') {
      const { amount, orderId, description } = req.body || {};

      if (!amount || !orderId) {
        return res.status(400).json({ error: 'amount dan orderId wajib diisi' });
      }

      const auth = Buffer.from(SERVER_KEY + ':').toString('base64');

      // Midtrans Payment Link pakai endpoint /v1/payment-links
      const payload = {
        transaction_details: {
          order_id: orderId,
          gross_amount: parseInt(amount)
        },
        item_details: [{
          id: 'otp-number',
          price: parseInt(amount),
          quantity: 1,
          name: description || 'Nomor OTP'
        }],
        // Aktifkan semua metode pembayaran populer
        enabled_payments: [
          'credit_card', 'bca_va', 'bni_va', 'bri_va', 'other_va',
          'gopay', 'shopeepay', 'dana', 'ovo', 'qris',
          'indomaret', 'alfamart'
        ],
        customer_required: false,
        expiry: {
          duration: 10,
          unit: 'minutes'
        },
        usage_limit: 1, // link hanya bisa dipakai 1x
      };

      const { data } = await axios.post(
        `${BASE_URL}/v1/payment-links`,
        payload,
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return res.json({
        orderId: data.order_id,
        paymentUrl: data.payment_url, // link yang dibuka user
        amount: parseInt(amount),
      });
    }

    // ── CHECK STATUS TRANSAKSI ────────────────────────────
    if (action === 'status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

      const auth = Buffer.from(SERVER_KEY + ':').toString('base64');
      const { data } = await axios.get(
        `${BASE_URL}/v2/${orderId}/status`,
        { headers: { 'Authorization': `Basic ${auth}` } }
      );

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
    const msg = e.response?.data?.error_messages?.[0]
             || e.response?.data?.status_message
             || e.message;
    return res.status(500).json({ error: msg });
  }
};
