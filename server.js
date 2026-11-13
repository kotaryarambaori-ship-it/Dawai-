
const express = require("express");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL || !process.env.ADMIN_KEY) {
  console.error("DATABASE_URL or ADMIN_KEY is missing");
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "30kb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
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

  // पुराने Database में open_days ARRAY हो सकता है.
  // उसे TEXT में बदलकर पुराने दिनों की जानकारी सुरक्षित रखें.
  const column = await pool.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'places'
      AND column_name = 'open_days'
  `);

  if (column.rows[0]?.data_type === "ARRAY") {
    await pool.query(`
      ALTER TABLE places
      ALTER COLUMN open_days TYPE TEXT
      USING array_to_string(open_days, ', ')
    `);

    console.log("open_days column converted to TEXT");
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS places_location_type_idx
    ON places (LOWER(village), LOWER(tehsil), LOWER(district), type)
  `);

  console.log("Database ready");
}

function adminAuth(req, res, next) {
  const supplied = Buffer.from(req.headers["x-admin-key"] || "");
  const expected = Buffer.from(process.env.ADMIN_KEY);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return res.status(401).json({
      ok: false,
      error: "गलत Admin Key",
    });
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
    const result = await pool.query(
      "SELECT COUNT(*)::int AS total_places FROM places"
    );

    res.json({
      ok: true,
      database: "connected",
      totalPlaces: result.rows[0].total_places,
    });
  } catch (err) {
    console.error("Health error:", err.message);

    res.status(503).json({
      ok: false,
      database: "disconnected",
    });
  }
});

app.get("/api/search", searchLimiter, async (req, res) => {
  try {
    const village = String(req.query.village || "").trim();
    const tehsil = String(req.query.tehsil || "").trim();
    const district = String(req.query.district || "").trim();
    const type = String(req.query.type || "all").trim();

    if (!village || !tehsil || !district) {
      return res.status(400).json({
        ok: false,
        error: "गाँव, तहसील और जिला भरना जरूरी है",
      });
    }

    if (!["all", "doctor", "medical"].includes(type)) {
      return res.status(400).json({
        ok: false,
        error: "गलत प्रकार चुना गया है",
      });
    }

    const values = [
      `%${village}%`,
      `%${tehsil}%`,
      `%${district}%`,
    ];

    let sql = `
      SELECT id, name, type, village, tehsil, district,
             address, phone, open_time, close_time, open_days
      FROM places
      WHERE LOWER(BTRIM(village)) LIKE LOWER($1)
        AND LOWER(BTRIM(tehsil)) LIKE LOWER($2)
        AND LOWER(BTRIM(district)) LIKE LOWER($3)
    `;

    if (type !== "all") {
      values.push(type);
      sql += " AND type = $4";
    }

    sql += " ORDER BY name ASC LIMIT 100";

    const result = await pool.query(sql, values);

    res.json({
      ok: true,
      count: result.rows.length,
      results: result.rows,
    });
  } catch (err) {
    console.error("Search error:", err.message);

    res.status(500).json({
      ok: false,
      error: "Search में सर्वर की समस्या हुई",
    });
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
      !name?.trim() ||
      !village?.trim() ||
      !tehsil?.trim() ||
      !district?.trim() ||
      !["doctor", "medical"].includes(type)
    ) {
      return res.status(400).json({
        ok: false,
        error: "सभी जरूरी जानकारी सही भरें",
      });
    }

    const result = await pool.query(
      `INSERT INTO places
      (name, type, village, tehsil, district, address,
       phone, open_time, close_time, open_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [
        name.trim(),
        type,
        village.trim(),
        tehsil.trim(),
        district.trim(),
        address?.trim() || null,
        phone?.trim() || null,
        openTime || null,
        closeTime || null,
        openDays?.trim() || null,
      ]
    );

    res.status(201).json({
      ok: true,
      message: "जानकारी सफलतापूर्वक सेव हो गई",
      place: result.rows[0],
    });
  } catch (err) {
    console.error("Add place error:", err.message);

    res.status(500).json({
      ok: false,
      error: "जानकारी सेव नहीं हो सकी",
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found",
  });
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
