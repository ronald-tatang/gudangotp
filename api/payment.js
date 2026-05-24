const axios = require('axios');

// Midtrans SNAP API (menggantikan Payment Link)
// Docs: https://docs.midtrans.com/reference/snap-api
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;

const SNAP_URL   = 'https://app.midtrans.com/snap/v1/transactions'; // production
const STATUS_URL = 'https://api.midtrans.com/v2';                   // production

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'create';
  const auth   = Buffer.from(SERVER_KEY + ':').toString('base64');

  try {

    // ── CREATE SNAP TRANSACTION ───────────────────────────
    if (action === 'create' && req.method === 'POST') {
      const { amount, orderId, description } = req.body || {};

      if (!amount || !orderId) {
        return res.status(400).json({ error: 'amount dan orderId wajib diisi' });
      }

      const payload = {
        transaction_details: {
          order_id:     orderId,
          gross_amount: parseInt(amount),
        },
        item_details: [{
          id:       'otp-number',
          price:    parseInt(amount),
          quantity: 1,
          name:     description || 'Nomor OTP',
        }],
        enabled_payments: [
          'gopay', 'shopeepay', 'dana', 'ovo', 'qris',
          'bca_va', 'bni_va', 'bri_va', 'other_va',
          'indomaret', 'alfamart',
        ],
        expiry: {
          duration: 10,
          unit: 'minutes',
        },
        callbacks: {
          finish: 'https://gudangotp.vercel.app/finish',
        },
      };

      // Snap endpoint — bukan /v1/payment-links
      const { data } = await axios.post(SNAP_URL, payload, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type':  'application/json',
        },
      });

      // Snap return redirect_url → support deep link GoPay otomatis
      return res.json({
        orderId:    orderId,
        paymentUrl: data.redirect_url, // https://app.midtrans.com/snap/v4/...
        token:      data.token,
        amount:     parseInt(amount),
      });
    }

    // ── CHECK STATUS TRANSAKSI ────────────────────────────
    if (action === 'status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

      const { data } = await axios.get(
        `${STATUS_URL}/${orderId}/status`,
        { headers: { 'Authorization': `Basic ${auth}` } },
      );

      const paid =
        data.transaction_status === 'settlement' ||
        data.transaction_status === 'capture';

      return res.json({
        orderId: data.order_id,
        status:  data.transaction_status,
        paid,
        amount:  data.gross_amount,
      });
    }

    return res.status(404).json({ error: 'Action tidak dikenal' });

  } catch (e) {
    const msg =
      e.response?.data?.error_messages?.[0] ||
      e.response?.data?.status_message ||
      e.message;
    return res.status(500).json({ error: msg });
  }
};
