require("dotenv").config();
const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "coinexia";
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

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
      transactions: {
        data: [],
        current_page: 1,
        last_page: 1,
        next_page_url: null,
        prev_page_url: null,
      },
    });
  });

  // Module checking stub (safe)
  app.get("/api/module/checking", authMiddleware, (_req, res) => {
    return ok(res, {
      exchange_module: 1,
      buy_module: 1,
      sell_module: 1,
      staking_module: 1,
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
      result: [
        { name: "Bitcoin",  image: "http://10.0.2.2:3000/images/bitcoin.png",  currency: "BTC",  today_price: "65000", previous_price: "64000", percentage_change: "1.2", sign: "+" },
        { name: "Ethereum", image: "http://10.0.2.2:3000/images/ethereum.png", currency: "ETH",  today_price: "3500",  previous_price: "3520",  percentage_change: "0.6", sign: "-" },
        { name: "Solana",   image: "http://10.0.2.2:3000/images/sol.png",     currency: "SOL",  today_price: "150",   previous_price: "145",   percentage_change: "3.1", sign: "+" },
        { name: "Tether",   image: "http://10.0.2.2:3000/images/ethereum.png", currency: "USDT", today_price: "1",     previous_price: "1",     percentage_change: "0.0", sign: "+" },
      ],
    });
  });

  // ───────────────────────────────────────────────────────────
  // Currency List (Popular Currencies UI)
  // ───────────────────────────────────────────────────────────
  app.get("/api/currency/list", authMiddleware, (_req, res) => {
    return res.json({
      status: "success",
      message: [
        { id: 1, symbol: "BTC", name: "Bitcoin",  price: 65000, change_24h:  1.2 },
        { id: 2, symbol: "ETH", name: "Ethereum", price: 3500,  change_24h: -0.6 },
        { id: 3, symbol: "SOL", name: "Solana",   price: 150,   change_24h:  3.1 },
        { id: 4, symbol: "USDT",name: "Tether",   price: 1,     change_24h:  0.0 },
      ],
    });
  });

  // ───────────────────────────────────────────────────────────
  // Balance — BalanceListModel expects message.wallets[] + totalDollarEqual
  // ───────────────────────────────────────────────────────────
  app.get("/api/get/balance", authMiddleware, (_req, res) => {
    return ok(res, {
      wallets: [
        { balance: "0", currencyName: "Bitcoin",  currencyCode: "BTC",  currencyImage: "http://10.0.2.2:3000/images/bitcoin.png",  dollarEqual: "0" },
        { balance: "0", currencyName: "Ethereum", currencyCode: "ETH",  currencyImage: "http://10.0.2.2:3000/images/ethereum1.png", dollarEqual: "0" },
        { balance: "0", currencyName: "Tether",   currencyCode: "USDT", currencyImage: "http://10.0.2.2:3000/images/bitcoin.png",  dollarEqual: "0" },
      ],
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
    return ok(res, {
      currencies: [
        { id: 1, code: "BTC", name: "Bitcoin",  symbol: "BTC" },
        { id: 2, code: "ETH", name: "Ethereum", symbol: "ETH" },
      ],
      rates: {},
    });
  });

  // ───────────────────────────────────────────────────────────
  // Pusher config stub
  // ───────────────────────────────────────────────────────────
  app.get("/api/pusher/config", authMiddleware, (_req, res) => {
    return ok(res, { key: "", cluster: "mt1", enabled: false });
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