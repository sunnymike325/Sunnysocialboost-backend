// SunnySocialBoost — Paystack backend
// Handles: initializing a payment, verifying it server-side, and a webhook
// to catch payment confirmations even if the customer closes their browser.

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
console.log("DEBUG - all env keys:const PORT = process.env.PORT || 4000;

if (!PAYSTACK_SECRET_KEY) {
  console.error("Missing PAYSTACK_SECRET_KEY in .env — server cannot start safely.");
  process.exit(1);
}

const orders = new Map();

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

    orders.set(reference, {
      reference,
      email,
      service,
      qty,
      link,
      amountNaira,
      status: "pending_payment",
      createdAt: new Date().toISOString(),
    });

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
    const order = orders.get(reference);

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
      const expectedKobo = Math.round(Number(order.amountNaira) * 100);
      if (txn.amount !== expectedKobo) {
        order.status = "amount_mismatch";
        orders.set(reference, order);
        return res.status(400).json({ error: "Amount mismatch — do not fulfill this order." });
      }

      order.status = "paid";
      order.paidAt = new Date().toISOString();
      orders.set(reference, order);

      return res.json({ status: "paid", order });
    } else {
      order.status = "failed";
      orders.set(reference, order);
      return res.json({ status: "failed", order });
    }
  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).json({ error: "Server error verifying payment." });
  }
});

app.post("/api/paystack/webhook", express.raw({ type: "*/*" }), (req, res) => {
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
    const order = orders.get(reference);
    if (order && order.status !== "paid") {
      order.status = "paid";
      order.paidAt = new Date().toISOString();
      orders.set(reference, order);
    }
  }

  return res.sendStatus(200);
});

app.get("/api/orders", (req, res) => {
  res.json(Array.from(orders.values()));
});

app.listen(PORT, () => {
  console.log(`SunnySocialBoost backend running on port ${PORT}`);
});
