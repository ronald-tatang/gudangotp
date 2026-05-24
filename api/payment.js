const axios = require('axios');

// ─────────────────────────────────────────────────────────────
//  Midtrans SNAP API  (menggantikan Payment Link)
//  Docs: https://docs.midtrans.com/reference/snap-api
//
//  Set environment variable di Vercel Dashboard:
//    MIDTRANS_SERVER_KEY = Mid-server-xxxx
// ─────────────────────────────────────────────────────────────
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;

// Gunakan sandbox untuk testing, production untuk live
const SNAP_URL  = 'https://app.midtrans.com/snap/v1/transactions';       // production
// const SNAP_URL = 'https://app.sandbox.midtrans.com/snap/v1/transactions'; // sandbox

const STATUS_URL = 'https://api.midtrans.com/v2';       // production
// const STATUS_URL = 'https://api.sandbox.midtrans.com/v2'; // sandbox

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
        // Hanya tampilkan e-wallet + VA — skip kartu kredit agar GoPay muncul duluan
        enabled_payments: [
          'gopay', 'shopeepay', 'dana', 'ovo', 'qris',
          'bca_va', 'bni_va', 'bri_va', 'other_va',
          'indomaret', 'alfamart',
        ],
        expiry: {
          duration: 10,
          unit: 'minutes',
        },
        // Setelah bayar, Snap redirect ke sini → Flutter tangkap via onPageFinished
        callbacks: {
          finish: 'https://gudangotp.vercel.app/finish',
        },
      };

      const { data } = await axios.post(SNAP_URL, payload, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type':  'application/json',
        },
      });

      // Snap return: { token: "...", redirect_url: "https://app.midtrans.com/snap/v4/..." }
      return res.json({
        orderId:    orderId,
        paymentUrl: data.redirect_url,  // ← Snap URL, support deep link GoPay otomatis
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
