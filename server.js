
const express = require("express");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL || !process.env.ADMIN_KEY) {
  console.error("DATABASE_URL or ADMIN_KEY is missing");
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "30kb" }));

// Serve frontend from public folder
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS places (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('doctor', 'medical')),
      village TEXT NOT NULL,
      tehsil TEXT NOT NULL,
      district TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      open_time TEXT,
      close_time TEXT,
      open_days TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS places_location_type_idx
    ON places (LOWER(village), LOWER(tehsil), LOWER(district), type)
  `);

  console.log("Database ready");
}

function adminAuth(req, res, next) {
  const supplied = req.headers["x-admin-key"] || "";
  const expected = process.env.ADMIN_KEY;

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  const crypto = require("crypto");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (err) {
    console.error("Health check error:", err.message);
    res.status(503).json({ ok: false, database: "disconnected" });
  }
});

app.get("/api/search", searchLimiter, async (req, res) => {
  try {
    const { village, tehsil, district, type = "all" } = req.query;

    if (!village || !tehsil || !district) {
      return res.status(400).json({
        error: "Village, tehsil and district are required",
      });
    }

    if (!["all", "doctor", "medical"].includes(type)) {
      return res.status(400).json({ error: "Invalid type" });
    }

    const values = [
      `%${village}%`,
      `%${tehsil}%`,
      `%${district}%`,
    ];

    let sql = `
      SELECT * FROM places
      WHERE village ILIKE $1
      AND tehsil ILIKE $2
      AND district ILIKE $3
    `;

    if (type !== "all") {
      values.push(type);
      sql += ` AND type = $4`;
    }

    sql += " ORDER BY name ASC LIMIT 100";

    const result = await pool.query(sql, values);
    res.json({ ok: true, results: result.rows });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

app.post("/api/places", adminAuth, async (req, res) => {
  try {
    const {
      name,
      type,
      village,
      tehsil,
      district,
      address,
      phone,
      openTime,
      closeTime,
      openDays,
    } = req.body;

    if (
      !name ||
      !village ||
      !tehsil ||
      !district ||
      !["doctor", "medical"].includes(type)
    ) {
      return res.status(400).json({ error: "Invalid or missing fields" });
    }

    const result = await pool.query(
      `INSERT INTO places
      (name, type, village, tehsil, district, address, phone,
       open_time, close_time, open_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [
        name,
        type,
        village,
        tehsil,
        district,
        address || null,
        phone || null,
        openTime || null,
        closeTime || null,
        openDays || null,
      ]
    );

    res.status(201).json({
      ok: true,
      place: result.rows[0],
    });
  } catch (err) {
    console.error("Add place error:", err.message);
    res.status(500).json({ error: "Could not add place" });
  }
});

// Serve index.html from public folder
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

async function startServer() {
  try {
    await initDB();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Server startup failed:", err);
    process.exit(1);
  }
}

startServer();

process.on("SIGTERM", async () => {
  console.log("Closing database pool...");
  await pool.end();
  process.exit(0);
});
