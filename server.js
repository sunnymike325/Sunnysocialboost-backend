// SunnySocialBoost — Paystack backend (now with a real database)
// Handles: initializing a payment, verifying it server-side, and a webhook
// to catch payment confirmations even if the customer closes their browser.
// Orders are now stored permanently in Postgres instead of memory.

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!PAYSTACK_SECRET_KEY) {
  console.error("Missing PAYSTACK_SECRET_KEY in .env — server cannot start safely.");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env — server cannot start safely.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureTableExists() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      reference TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      service TEXT NOT NULL,
      qty INTEGER NOT NULL,
      link TEXT NOT NULL,
      amount_naira NUMERIC NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    )
  `);
  console.log("Orders table ready.");
}

app.post("/api/orders/initialize", async (req, res) => {
  try {
    const { email, amountNaira, service, qty, link } = req.body;

    if (!email || !amountNaira || !service || !qty || !link) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const amountKobo = Math.round(Number(amountNaira) * 100);
    const reference = "SSB-" + crypto.randomBytes(8).toString("hex");

    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: amountKobo,
        reference,
        callback_url: process.env.CALLBACK_URL || undefined,
      }),
    });

    const paystackData = await paystackRes.json();

    if (!paystackData.status) {
      return res.status(400).json({ error: paystackData.message || "Could not initialize payment." });
    }

    await pool.query(
      `INSERT INTO orders (reference, email, service, qty, link, amount_naira, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment')`,
      [reference, email, service, qty, link, amountNaira]
    );

    return res.json({
      authorization_url: paystackData.data.authorization_url,
      access_code: paystackData.data.access_code,
      reference,
    });
  } catch (err) {
    console.error("Initialize error:", err);
    return res.status(500).json({ error: "Server error initializing payment." });
  }
});

app.get("/api/orders/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    const orderResult = await pool.query("SELECT * FROM orders WHERE reference = $1", [reference]);
    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      }
    );
    const paystackData = await paystackRes.json();

    if (!paystackData.status) {
      return res.status(400).json({ error: "Could not verify transaction." });
    }

    const txn = paystackData.data;

    if (txn.status === "success") {
      const expectedKobo = Math.round(Number(order.amount_naira) * 100);
      if (txn.amount !== expectedKobo) {
        await pool.query("UPDATE orders SET status = 'amount_mismatch' WHERE reference = $1", [reference]);
        return res.status(400).json({ error: "Amount mismatch — do not fulfill this order." });
      }

      await pool.query(
        "UPDATE orders SET status = 'paid', paid_at = now() WHERE reference = $1",
        [reference]
      );

      const updated = await pool.query("SELECT * FROM orders WHERE reference = $1", [reference]);
      return res.json({ status: "paid", order: updated.rows[0] });
    } else {
      await pool.query("UPDATE orders SET status = 'failed' WHERE reference = $1", [reference]);
      return res.json({ status: "failed" });
    }
  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).json({ error: "Server error verifying payment." });
  }
});

app.post("/api/paystack/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const body = req.body;

  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(body)
    .digest("hex");

  if (hash !== signature) {
    return res.sendStatus(401);
  }

  const event = JSON.parse(body.toString());

  if (event.event === "charge.success") {
    const reference = event.data.reference;
    try {
      await pool.query(
        "UPDATE orders SET status = 'paid', paid_at = now() WHERE reference = $1 AND status != 'paid'",
        [reference]
      );
    } catch (err) {
      console.error("Webhook DB update error:", err);
    }
  }

  return res.sendStatus(200);
});

app.get("/api/orders", async (req, res) => {
  const providedKey = req.query.key;
  const ADMIN_KEY = process.env.ADMIN_KEY;

  if (!ADMIN_KEY) {
    return res.status(500).json({ error: "Admin key not configured on server." });
  }
  if (providedKey !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized. Add ?key=YOUR_ADMIN_KEY to the URL." });
  }

  try {
    const result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("List orders error:", err);
    res.status(500).json({ error: "Could not fetch orders." });
  }
});

ensureTableExists()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`SunnySocialBoost backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to set up database table:", err);
    process.exit(1);
  });
