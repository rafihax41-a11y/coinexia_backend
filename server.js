require("dotenv").config();
const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "coinexia";
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

const MAIL_USER = process.env.MAIL_USER || "";
const MAIL_PASS = process.env.MAIL_PASS || "";

// In-memory OTP store: key=email, value={code, expiresAt}
const OTP_STORE = new Map();
function makeOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: MAIL_USER, pass: MAIL_PASS },
});

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is not defined in .env");
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET is not defined in .env");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Helpers (Laravel-style responses)
// ─────────────────────────────────────────────────────────────
function ok(res, message) {
  return res.status(200).json({ status: "success", message });
}
function err(res, message) {
  return res.status(200).json({ status: "error", message });
}

// ─────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/images", require("express").static(require("path").join(__dirname, "public", "images")));

// Request logger (safe)
app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`[${res.statusCode}] ${req.method} ${req.originalUrl}`);
  });
  next();
});

// ─────────────────────────────────────────────────────────────
// MongoDB Client
// ─────────────────────────────────────────────────────────────
const client = new MongoClient(MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), username: user.username, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return err(res, "No token provided");
  }
  const token = authHeader.slice("Bearer ".length).trim();
  try {
    req.user = jwt.verify(token, JWT_SECRET); // { id, username, email }
    return next();
  } catch {
    return err(res, "Invalid or expired token");
  }
}

// ─────────────────────────────────────────────────────────────
// Static coin data (update prices/images here only)
// ─────────────────────────────────────────────────────────────
const BASE_URL = "http://10.0.2.2:3000";
const COINS = [
  { code: "BTC",  name: "Bitcoin",  image: `${BASE_URL}/images/bitcoin.png`,   today_price: "65000", previous_price: "64000", percentage_change: "1.2", sign: "+" },
  { code: "ETH",  name: "Ethereum", image: `${BASE_URL}/images/ethereum1.png`, today_price: "3500",  previous_price: "3520",  percentage_change: "0.6", sign: "-" },
  { code: "SOL",  name: "Solana",   image: `${BASE_URL}/images/sol.png`,       today_price: "150",   previous_price: "145",   percentage_change: "3.1", sign: "+" },
  { code: "USDT", name: "Tether",   image: `${BASE_URL}/images/tether.png`,   today_price: "1",     previous_price: "1",     percentage_change: "0.0", sign: "+" },
];

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function run() {
  await client.connect();
  console.log("✅ Connected to MongoDB");
  console.log("🔥 RUNNING_PRODUCTION_SAFE_SERVER");

  const db = client.db(DB_NAME);
  const users = db.collection("users");

  // Indexes
  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ username: 1 }, { unique: true });

  // ───────────────────────────────────────────────────────────
  // Health + Root
  // ───────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => ok(res, "OK"));
  app.get("/", (_req, res) => ok(res, "Coinexia backend running 🚀"));

  // ───────────────────────────────────────────────────────────
  // Stability endpoints (to prevent Flutter crashes)
  // These endpoints MUST return JSON, even if dummy.
  // ───────────────────────────────────────────────────────────

  // LanguageModel.fromJson expects message to be a Map with a "languages" key
  app.get("/api/language", (_req, res) => {
    return ok(res, {
      languages: [
        { id: 1, name: "English", short_name: "en", flag: "" },
        { id: 2, name: "Bangla",  short_name: "bn", flag: "" },
      ],
    });
  });

  // Minimal dashboard stub (safe)
  app.get("/api/dashboard", authMiddleware, (_req, res) => {
    return ok(res, {
      notice: "stub",
      total_balance: 0,
      total_transactions: 0,
    });
  });

  // TransactionModel.fromJson expects message.transactions.data
  app.get("/api/transaction", authMiddleware, (_req, res) => {
    return ok(res, {
      data: [],
      current_page: 1,
      last_page: 1,
      next_page_url: null,
      prev_page_url: null,
    });
  });

  // Module checking stub (safe)
  app.get("/api/module/checking", authMiddleware, (_req, res) => {
    return ok(res, {
      exchangeModule: 1,
      buyModule: 1,
      sellModule: 1,
      stakingModule: 1,
    });
  });

  // ───────────────────────────────────────────────────────────
  // Auth
  // ───────────────────────────────────────────────────────────
  app.post("/api/register", async (req, res, next) => {
    try {
      const {
        firstname,
        lastname,
        username,
        email,
        country,
        country_code,
        phone,
        phone_code,
        password,
        password_confirmation,
      } = req.body || {};

      if (!firstname || !username || !email || !password || !password_confirmation) {
        return err(res, "Required fields missing");
      }
      if (password !== password_confirmation) {
        return err(res, "Password confirmation not match");
      }

      const now = new Date();
      const doc = {
        firstname: String(firstname).trim(),
        lastname: String(lastname || "").trim(),
        username: String(username).trim(),
        email: String(email).toLowerCase().trim(),
        country: country || "",
        country_code: country_code || "",
        phone: phone || "",
        phone_code: phone_code || "",
        password: await bcrypt.hash(password, 10),
        createdAt: now,
        updatedAt: now,
      };

      const result = await users.insertOne(doc);
      const token = signToken({ ...doc, _id: result.insertedId });

      // Flutter expects token here
      return res.status(200).json({
        status: "success",
        message: "User registered successfully",
        token,
      });
    } catch (e) {
      if (e?.code === 11000) {
        const field = Object.keys(e.keyPattern || {})[0] || "field";
        return err(res, field === "email" ? "Email already exists" : "Username already exists");
      }
      return next(e);
    }
  });

  app.post("/api/login", async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return err(res, "Username and password are required");
      }

      const login = String(username).trim();
      const user = await users.findOne({
        $or: [{ username: login }, { email: login.toLowerCase() }],
      });
      if (!user) return err(res, "Invalid credentials");

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return err(res, "Invalid credentials");

      const token = signToken(user);

      return res.json({
        status: "success",
        message: "Login successful",
        token,
      });
    } catch (e) {
      return next(e);
    }
  });

  // ───────────────────────────────────────────────────────────
  // Flutter Profile endpoint (must match your ProfileModel)
  // ───────────────────────────────────────────────────────────
  app.get("/api/get/account/info", authMiddleware, async (req, res, next) => {
    try {
      const user = await users.findOne({ _id: new ObjectId(req.user.id) });
      if (!user) return err(res, "User not found");

      return ok(res, {
        image: user.image || "",
        firstName: user.firstname || "",
        lastName: user.lastname || "",
        username: user.username || "",
        email: user.email || "",
        phoneCode: user.phone_code || "",
        phone: user.phone || "",
        country: user.country || "",
        country_code: user.country_code || "",
        language: user.language || "",
        languageId: user.languageId || "",
        address: user.address || "",
        join_date: user.createdAt ? new Date(user.createdAt).toISOString() : "",
      });
    } catch (e) {
      return next(e);
    }
  });

  // Optional: current user safe endpoint
  app.get("/api/me", authMiddleware, async (req, res, next) => {
    try {
      const user = await users.findOne(
        { _id: new ObjectId(req.user.id) },
        { projection: { password: 0 } }
      );
      if (!user) return err(res, "User not found");
      return ok(res, user);
    } catch (e) {
      return next(e);
    }
  });

  // ───────────────────────────────────────────────────────────
  // Currency Rate — CoinMarketModel expects message.result[]
  // ───────────────────────────────────────────────────────────
  app.get("/api/currency/rate", authMiddleware, (_req, res) => {
    return ok(res, {
      result: COINS.map((c) => ({ name: c.name, image: c.image, currency: c.code, today_price: c.today_price, previous_price: c.previous_price, percentage_change: c.percentage_change, sign: c.sign })),
    });
  });

  // ───────────────────────────────────────────────────────────
  // Currency List (Popular Currencies UI)
  // ───────────────────────────────────────────────────────────
  app.get("/api/currency/list", authMiddleware, (_req, res) => {
    return res.json({
      status: "success",
      message: COINS.map((c) => ({ id: c.id, symbol: c.code, name: c.name, price: c.today_price, change_24h: c.percentage_change })),
    });
  });

  // ───────────────────────────────────────────────────────────
  // Balance — BalanceListModel expects message.wallets[] + totalDollarEqual
  // ───────────────────────────────────────────────────────────
  app.get("/api/get/balance", authMiddleware, (_req, res) => {
    return ok(res, {
      wallets: COINS.map((c) => ({ balance: "0", currencyName: c.name, currencyCode: c.code, currencyImage: c.image, dollarEqual: "0" })),
      totalDollarEqual: "0",
    });
  });

  // ───────────────────────────────────────────────────────────
  // Portfolio
  // ───────────────────────────────────────────────────────────
  app.get("/api/portfolio", authMiddleware, (_req, res) => {
    return ok(res, { total_value: 0, items: [] });
  });

  // ───────────────────────────────────────────────────────────
  // Currency chart — market_controller expects message.currencies + message.rates
  // ───────────────────────────────────────────────────────────
  app.get("/api/all/currency/chart", authMiddleware, (_req, res) => {
    const now = new Date().toISOString();
    return ok(res, {
      currencies: ["BTC", "ETH", "SOL", "USDT"],
      rates: {
        BTC:  [{ code: "BTC",  price: "65000", created_at: now }],
        ETH:  [{ code: "ETH",  price: "3500",  created_at: now }],
        SOL:  [{ code: "SOL",  price: "150",   created_at: now }],
        USDT: [{ code: "USDT", price: "1",     created_at: now }],
      },
    });
  });

  // ───────────────────────────────────────────────────────────
  // Currency chart data (per coin)
  // ───────────────────────────────────────────────────────────
  app.get("/api/currency/chart-data", authMiddleware, (req, res) => {
    const code = (req.query.code || "BTC").toString().toUpperCase();
    const coin = COINS.find((c) => c.code === code);
    const now = new Date().toISOString();
    return ok(res, {
      rates: [
        { code, price: coin ? coin.today_price : "0", created_at: now },
      ],
    });
  });

  // ───────────────────────────────────────────────────────────
  // Currency market details
  // ───────────────────────────────────────────────────────────
  app.get("/api/currency/market-details", authMiddleware, (_req, res) => {
    return ok(res, {
      market: {
        market_cap_dominance: "0",
        volume_24h: "0",
        volume_change_24h: "0",
        percent_change_24h: "0",
      },
    });
  });

  // ───────────────────────────────────────────────────────────
  // Pusher config stub
  // ───────────────────────────────────────────────────────────
  app.get("/api/pusher/config", authMiddleware, (_req, res) => {
    return ok(res, { apiKey: "", cluster: "", channel: "" });
  });

  // ───────────────────────────────────────────────────────────
  // Staking — StakingResponse.fromJson shape
  // ───────────────────────────────────────────────────────────
  app.get("/api/staking", authMiddleware, (_req, res) => {
    return ok(res, {
      unlock_day: 0,
      pools: [],
      stakes: { data: [], current_page: 1, last_page: 1 },
      currencies: [],
    });
  });

  // ───────────────────────────────────────────────────────────
  // Staking statics — StakeStatistics.fromJson shape
  // ───────────────────────────────────────────────────────────
  app.get("/api/staking/statics", authMiddleware, (_req, res) => {
    return ok(res, {
      total_staked: 0,
      stakeStats: { total_staked: 0, total_rewards: 0 },
      todayReward: 0,
      stakes: [],
    });
  });

  // ───────────────────────────────────────────────────────────
  // Profile Update
  // ───────────────────────────────────────────────────────────
  app.post("/api/account/info/update", authMiddleware, async (req, res, next) => {
    try {
      const { firstname, lastname, username, email, phone, phone_code, address, country, country_code } = req.body || {};
      await users.updateOne(
        { _id: new ObjectId(req.user.id) },
        { $set: { firstname, lastname, username, email, phone, phone_code, address, country, country_code, updatedAt: new Date() } }
      );
      return ok(res, "Profile updated successfully");
    } catch (e) { return next(e); }
  });

  app.post("/api/account/password/update", authMiddleware, async (req, res, next) => {
    try {
      const { current_password, password, password_confirmation } = req.body || {};
      if (!current_password || !password || !password_confirmation) return err(res, "All fields required");
      if (password !== password_confirmation) return err(res, "Password confirmation not match");
      const user = await users.findOne({ _id: new ObjectId(req.user.id) });
      if (!user) return err(res, "User not found");
      const isMatch = await bcrypt.compare(current_password, user.password);
      if (!isMatch) return err(res, "Current password is incorrect");
      const hashed = await bcrypt.hash(password, 10);
      await users.updateOne({ _id: new ObjectId(req.user.id) }, { $set: { password: hashed, updatedAt: new Date() } });
      return ok(res, "Password updated successfully");
    } catch (e) { return next(e); }
  });

  app.post("/api/account/delete", authMiddleware, async (req, res, next) => {
    try {
      await users.deleteOne({ _id: new ObjectId(req.user.id) });
      return ok(res, "Account deleted");
    } catch (e) { return next(e); }
  });

  // ───────────────────────────────────────────────────────────
  // Forgot Password (Real OTP via Gmail)
  // ───────────────────────────────────────────────────────────
  app.post("/api/password-recovery/get-code", async (req, res) => {
    const { email } = req.body || {};
    if (!email) return err(res, "Email is required");

    const user = await users.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) return err(res, "No account found with this email");

    const code = makeOtp();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    OTP_STORE.set(String(email).toLowerCase().trim(), { code, expiresAt });

    try {
      await mailer.sendMail({
        from: `"Coinexia" <${MAIL_USER}>`,
        to: email,
        subject: "Password Reset OTP",
        html: `<h2>Your OTP Code</h2><p>Use this code to reset your password:</p><h1 style="letter-spacing:4px">${code}</h1><p>This code expires in <b>10 minutes</b>.</p>`,
      });
      return ok(res, { message: "OTP sent to your email" });
    } catch (e) {
      console.error("[MAIL ERROR]", e.message);
      return err(res, "Failed to send email. Check server mail config.");
    }
  });

  app.post("/api/password-recovery/verify-code", (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) return err(res, "Email and code are required");

    const key = String(email).toLowerCase().trim();
    const stored = OTP_STORE.get(key);
    if (!stored) return err(res, "OTP not found. Please request a new one.");
    if (Date.now() > stored.expiresAt) {
      OTP_STORE.delete(key);
      return err(res, "OTP has expired. Please request a new one.");
    }
    if (String(code).trim() !== stored.code) return err(res, "Invalid OTP");

    const token = jwt.sign({ email: key, purpose: "reset" }, JWT_SECRET, { expiresIn: "15m" });
    return ok(res, { token });
  });

  app.post("/api/update-pass", async (req, res) => {
    const { password, password_confirmation, token } = req.body || {};
    if (!password || !password_confirmation || !token) return err(res, "Required fields missing");
    if (password !== password_confirmation) return err(res, "Password confirmation not match");

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.purpose !== "reset" || !decoded.email) return err(res, "Invalid reset token");

      const hashed = await bcrypt.hash(password, 10);
      await users.updateOne(
        { email: decoded.email },
        { $set: { password: hashed, updatedAt: new Date() } }
      );
      OTP_STORE.delete(decoded.email);
      return ok(res, "Password updated successfully");
    } catch {
      return err(res, "Invalid or expired reset token");
    }
  });

  // ───────────────────────────────────────────────────────────
  // Verification (mail / sms / 2FA / KYC)
  // ───────────────────────────────────────────────────────────
  app.get("/api/resend-code", authMiddleware, async (req, res) => {
    const email = req.user.email;
    const now = Date.now();
    const existing = OTP_STORE.get(email);

    // 60-second cooldown (regardless of purpose)
    if (existing && existing.lastSentAt && (now - existing.lastSentAt) < 60 * 1000) {
      return err(res, "Please wait before requesting a new code");
    }

    const code = makeOtp();
    OTP_STORE.set(email, {
      code,
      expiresAt:   now + 10 * 60 * 1000,
      purpose:     "email_verify",
      lastSentAt:  now,
      attempts:    0,
      blockedUntil: null,
    });

    try {
      await mailer.sendMail({
        from: `"Coinexia" <${MAIL_USER}>`,
        to: email,
        subject: "Coinexia Email Verification",
        html: `<h2>Email Verification</h2><p>Your verification code is:</p><h1 style="letter-spacing:4px">${code}</h1><p>This code expires in <b>10 minutes</b>.</p>`,
      });
      return ok(res, { message: "Verification code sent" });
    } catch (e) {
      console.error("[MAIL ERROR]", e.message);
      OTP_STORE.delete(email);
      return err(res, "Failed to send email. Check server mail config.");
    }
  });

  app.post("/api/mail-verify", authMiddleware, async (req, res) => {
    const email = req.user.email;
    const { code } = req.body || {};
    if (!code) return err(res, "Verification code is required");

    const stored = OTP_STORE.get(email);
    if (!stored || stored.purpose !== "email_verify") {
      return err(res, "No verification code found. Please resend code");
    }

    const now = Date.now();

    // Brute-force block
    if (stored.blockedUntil && now < stored.blockedUntil) {
      return err(res, "Too many attempts. Try again later");
    }

    // Expiry check
    if (now > stored.expiresAt) {
      OTP_STORE.delete(email);
      return err(res, "Verification code expired. Please resend code");
    }

    // Code mismatch
    if (String(code).trim() !== stored.code) {
      stored.attempts += 1;
      if (stored.attempts >= 5) {
        stored.blockedUntil = now + 10 * 60 * 1000;
        return err(res, "Too many attempts. Try again later");
      }
      return err(res, "Invalid verification code");
    }

    // Success
    await users.updateOne(
      { _id: new ObjectId(req.user.id) },
      { $set: { emailVerified: true, updatedAt: new Date() } }
    );
    OTP_STORE.delete(email);
    return ok(res, "Email verified successfully");
  });

  app.post("/api/sms-verify",   authMiddleware, (_req, res) => ok(res, "SMS verified"));
  app.post("/api/twoFA-Verify", authMiddleware, (_req, res) => ok(res, "2FA verified"));

  app.get("/api/2FA-security", authMiddleware, (_req, res) => {
    return ok(res, { twoFactorEnable: false, secret: "", qrCodeUrl: "" });
  });
  app.post("/api/2FA-security/enable",  authMiddleware, (_req, res) => ok(res, "2FA enabled"));
  app.post("/api/2FA-security/disable", authMiddleware, (_req, res) => ok(res, "2FA disabled"));

  // ───────────────────────────────────────────────────────────
  // Balance / Deposit
  // ───────────────────────────────────────────────────────────
  app.get("/api/get/generated/address", authMiddleware, (_req, res) => {
    return ok(res, { address: [] });
  });

  app.post("/api/make/deposit/address", authMiddleware, (_req, res) => {
    return ok(res, { address: "", crypto_wallet_id: "0", showManualField: false });
  });

  app.post("/api/manual/deposit/confirm", authMiddleware, (_req, res) => {
    return ok(res, "Deposit submitted");
  });

  // ───────────────────────────────────────────────────────────
  // Exchange
  // ───────────────────────────────────────────────────────────
  app.get("/api/exchange/currency", authMiddleware, (_req, res) => {
    return ok(res, { initialSendAmount: "0.01", sendCurrencies: [], getCurrencies: [] });
  });

  app.get("/api/exchange/rate", authMiddleware, (_req, res) => {
    return ok(res, { sendAmount: "0", getAmount: "0", exchangeRate: "0", service_fee: "0", network_fee: "0", finalAmount: "0" });
  });

  app.post("/api/exchange/initiate", authMiddleware, (_req, res) => {
    return ok(res, { utr: "EXC-" + Date.now() });
  });

  app.get("/api/exchange/address/generate/:utr", authMiddleware, (_req, res) => {
    return ok(res, { adminAddress: "" });
  });

  app.post("/api/exchange/payment/confirm", authMiddleware, (_req, res) => {
    return ok(res, "Payment confirmed");
  });

  app.get("/api/exchange", authMiddleware, (_req, res) => {
    return ok(res, { data: [], next_page_url: null, current_page: 1 });
  });

  app.get("/api/exchange/view/:utr", authMiddleware, (_req, res) => {
    return ok(res, {});
  });

  // ───────────────────────────────────────────────────────────
  // Buy
  // ───────────────────────────────────────────────────────────
  app.get("/api/buy/currency", authMiddleware, (_req, res) => {
    return ok(res, { initialSendAmount: "0.01", sendCurrencies: [], getCurrencies: [] });
  });

  app.get("/api/buy/rate", authMiddleware, (_req, res) => {
    return ok(res, { sendAmount: "0", getAmount: "0", exchangeRate: "0", service_fee: "0", network_fee: "0", finalAmount: "0" });
  });

  app.post("/api/buy/initiate", authMiddleware, (_req, res) => {
    return ok(res, { utr: "BUY-" + Date.now() });
  });

  app.get("/api/buy", authMiddleware, (_req, res) => {
    return ok(res, { data: [], next_page_url: null, current_page: 1 });
  });

  app.get("/api/buy/view/:utr", authMiddleware, (_req, res) => {
    return ok(res, {});
  });

  // ───────────────────────────────────────────────────────────
  // Sell
  // ───────────────────────────────────────────────────────────
  app.get("/api/sell/currency", authMiddleware, (_req, res) => {
    return ok(res, { initialSendAmount: "0.01", sendCurrencies: [], getCurrencies: [] });
  });

  app.get("/api/sell/rate", authMiddleware, (_req, res) => {
    return ok(res, { sendAmount: "0", getAmount: "0", exchangeRate: "0", processing_fee: "0", finalAmount: "0" });
  });

  app.get("/api/sell/gateway/list", authMiddleware, (_req, res) => {
    return ok(res, { getCurrencySendInfo: [] });
  });

  app.post("/api/sell/initiate", authMiddleware, (_req, res) => {
    return ok(res, { utr: "SELL-" + Date.now() });
  });

  app.get("/api/sell/address/generate/:utr", authMiddleware, (_req, res) => {
    return ok(res, { adminAddress: "" });
  });

  app.post("/api/sell/payment/confirm", authMiddleware, (_req, res) => {
    return ok(res, "Payment confirmed");
  });

  app.get("/api/sell", authMiddleware, (_req, res) => {
    return ok(res, { data: [], next_page_url: null, current_page: 1 });
  });

  app.get("/api/sell/view/:utr", authMiddleware, (_req, res) => {
    return ok(res, {});
  });

  // ───────────────────────────────────────────────────────────
  // Payment Gateway
  // ───────────────────────────────────────────────────────────
  app.get("/api/gateway/list",        authMiddleware, (_req, res) => ok(res, { gateways: [] }));
  app.post("/api/payment/confirm",    authMiddleware, (_req, res) => ok(res, "Payment confirmed"));
  app.post("/api/manual-payment",     authMiddleware, (_req, res) => ok(res, "Payment submitted"));
  app.post("/api/show-other-payment", authMiddleware, (_req, res) => ok(res, ""));
  app.post("/api/card-payment",       authMiddleware, (_req, res) => ok(res, "Payment confirmed"));
  app.post("/api/payment-done",       authMiddleware, (_req, res) => ok(res, "Payment done"));

  // ───────────────────────────────────────────────────────────
  // Referral
  // ───────────────────────────────────────────────────────────
  app.get("/api/referral/info", authMiddleware, (_req, res) => {
    return ok(res, { link: "", directReferralUsers: [] });
  });

  app.get("/api/referral/bonuses", authMiddleware, (_req, res) => {
    return ok(res, { base_currency: "USD", currency: "$", referrals: { data: [], next_page_url: null } });
  });

  // ───────────────────────────────────────────────────────────
  // Support Ticket
  // ───────────────────────────────────────────────────────────
  app.get("/api/support-ticket/list", authMiddleware, (_req, res) => {
    return ok(res, { tickets: { data: [], next_page_url: null } });
  });

  app.post("/api/support-ticket/create", authMiddleware, (_req, res) => {
    return ok(res, "Ticket created");
  });

  app.get("/api/support-ticket/view/:id", authMiddleware, (_req, res) => {
    return res.json({ status: "success", message: { page_title: "Support Ticket", status: "open" }, data: { ticket: [] } });
  });

  app.post("/api/support-ticket/reply", authMiddleware, (_req, res) => {
    return ok(res, "Reply sent");
  });

  // ───────────────────────────────────────────────────────────
  // Staking actions
  // ───────────────────────────────────────────────────────────
  app.post("/api/staking",  authMiddleware, (_req, res) => ok(res, "Stake placed"));
  app.post("/api/unstake",  authMiddleware, (_req, res) => ok(res, "Unstaked successfully"));

  // ───────────────────────────────────────────────────────────
  // Funds & Tracking
  // ───────────────────────────────────────────────────────────
  app.get("/api/funds",    authMiddleware, (_req, res) => ok(res, { data: [] }));
  app.post("/api/funds",   authMiddleware, (_req, res) => ok(res, "Request submitted"));
  app.get("/api/tracking", authMiddleware, (_req, res) => ok(res, { data: [] }));

  // ───────────────────────────────────────────────────────────
  // 404 JSON fallback (prevents HTML responses)
  // ───────────────────────────────────────────────────────────
  app.use((req, res) => {
    return err(res, `Route not found: ${req.method} ${req.originalUrl}`);
  });

  // ───────────────────────────────────────────────────────────
  // Global error handler (ALWAYS JSON)
  // ───────────────────────────────────────────────────────────
  app.use((error, _req, res, _next) => {
    console.error("[UNHANDLED ERROR]", error);
    return err(res, "Server error");
  });

  // Start server
  app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    try {
      console.log("🛑 Shutting down...");
      await client.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

run().catch((e) => {
  console.error("❌ Startup failed:", e);
  process.exit(1);
});