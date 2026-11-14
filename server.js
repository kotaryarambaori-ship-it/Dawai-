
const express = require("express");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "30kb" }));

for (const key of ["DATABASE_URL", "ADMIN_KEY"]) {
  if (!process.env[key]) {
    console.error(`${key} is missing`);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/i.test(process.env.DATABASE_URL)
    ? false : { rejectUnauthorized: false }
});

const onlineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false
});

const saveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS places (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('doctor','medical')),
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

  const columns = [
    ["address", "TEXT"],
    ["phone", "TEXT"],
    ["open_time", "TEXT"],
    ["close_time", "TEXT"],
    ["open_days", "TEXT"]
  ];

  for (const [column, type] of columns) {
    await pool.query(
      `ALTER TABLE places ADD COLUMN IF NOT EXISTS ${column} ${type}`
    );
  }

  const info = await pool.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'places'
      AND column_name = 'open_days'
  `);

  if (info.rows[0]?.data_type === "ARRAY") {
    await pool.query(`
      ALTER TABLE places ALTER COLUMN open_days TYPE TEXT
      USING array_to_string(open_days, ', ')
    `);
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS places_location_idx
    ON places (lower(village), lower(tehsil), lower(district))
  `);

  console.log("Database ready");
}

function adminAuth(req, res, next) {
  const a = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const b = Buffer.from(String(process.env.ADMIN_KEY || ""));

  if (!a.length || a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      ok: false,
      error: "गलत Admin Key"
    });
  }
  next();
}

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS total FROM places"
    );

    res.json({
      ok: true,
      database: "connected",
      totalPlaces: result.rows[0].total,
      onlineSearchConfigured: Boolean(process.env.LANGSEARCH_API_KEY)
    });
  } catch (error) {
    console.error("Health error:", error.message);
    res.status(500).json({ ok: false, database: "error" });
  }
});

// Database: only the exact entered village, tehsil and district.
app.get("/api/search", async (req, res) => {
  try {
    const village = String(req.query.village || "").trim();
    const tehsil = String(req.query.tehsil || "").trim();
    const district = String(req.query.district || "").trim();
    const type = String(req.query.type || "all");

    if (!village || !tehsil || !district) {
      return res.status(400).json({
        ok: false,
        error: "गाँव, तहसील और जिला भरें।"
      });
    }

    if (!["all", "doctor", "medical"].includes(type)) {
      return res.status(400).json({ ok: false, error: "गलत प्रकार" });
    }

    let sql = `
      SELECT id,name,type,village,tehsil,district,address,phone,
      open_time,close_time,open_days
      FROM places
      WHERE lower(trim(village)) = lower(trim($1))
      AND lower(trim(tehsil)) = lower(trim($2))
      AND lower(trim(district)) = lower(trim($3))
    `;
    const values = [village, tehsil, district];

    if (type !== "all") {
      values.push(type);
      sql += ` AND type = $${values.length}`;
    }

    sql += " ORDER BY name LIMIT 100";
    const result = await pool.query(sql, values);

    res.json({ ok: true, count: result.rows.length, results: result.rows });
  } catch (error) {
    console.error("Database search:", error.message);
    res.status(500).json({ ok: false, error: "डेटाबेस खोज विफल हुई।" });
  }
});

app.post("/api/places", saveLimiter, adminAuth, async (req, res) => {
  try {
    const {
      name, type, village, tehsil, district,
      address, phone, openTime, closeTime, openDays
    } = req.body || {};

    if (![name, village, tehsil, district].every(
      x => typeof x === "string" && x.trim()
    )) {
      return res.status(400).json({
        ok: false, error: "नाम, गाँव, तहसील और जिला जरूरी हैं।"
      });
    }

    if (!["doctor", "medical"].includes(type)) {
      return res.status(400).json({ ok: false, error: "गलत प्रकार चुना।" });
    }

    const result = await pool.query(`
      INSERT INTO places
      (name,type,village,tehsil,district,address,phone,open_time,close_time,open_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `, [
      name.trim(), type, village.trim(), tehsil.trim(), district.trim(),
      address || "", phone || "", openTime || "", closeTime || "", openDays || ""
    ]);

    res.status(201).json({
      ok: true,
      message: "जानकारी सफलतापूर्वक सेव हो गई।",
      id: result.rows[0].id
    });
  } catch (error) {
    console.error("Add place error:", error.message);
    res.status(500).json({ ok: false, error: "जानकारी सेव नहीं हो सकी।" });
  }
});

// -------- Exact-village online web search --------

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
    .trim();
}

function matchesLocation(page, village, district) {
  const content = normalize([
    page.name, page.snippet, page.text, page.url
  ].join(" "));

  const villageName = normalize(village);
  const districtName = normalize(district);

  // Conservative filter: both village and district must be present.
  // This intentionally drops uncertain results rather than showing
  // a different village or state as if it were the requested village.
  return content.includes(villageName) &&
         content.includes(districtName);
}

async function langSearch(query) {
  const apiKey = process.env.LANGSEARCH_API_KEY;
  if (!apiKey) throw new Error("LANGSEARCH_API_KEY सेट नहीं है।");

  const response = await fetch(
    "https://api.langsearch.com/v1/web-search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        count: 10,
        contents: { text: { max_characters: 3000 } }
      }),
      signal: AbortSignal.timeout(30000)
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || String(payload.code) !== "200") {
    console.error("LangSearch API error:", response.status, payload.message);
    throw new Error(payload.message || `Search failed: ${response.status}`);
  }

  const pages = payload?.data?.webPages?.value || [];

  return pages.map(page => {
    let url = "";
    try {
      const parsed = new URL(page.url || "");
      if (["http:", "https:"].includes(parsed.protocol)) {
        url = parsed.href;
      }
    } catch (_) {}

    return {
      title: String(page.name || "ऑनलाइन जानकारी"),
      url,
      snippet: String(page.snippet || page.text || ""),
      text: String(page.text || ""),
      datePublished: page.datePublished || ""
    };
  }).filter(item => item.url);
}

app.get("/api/online-search", onlineLimiter, async (req, res) => {
  try {
    const village = String(req.query.village || "").trim();
    const tehsil = String(req.query.tehsil || "").trim();
    const district = String(req.query.district || "").trim();
    const type = String(req.query.type || "all");

    if (!village || !tehsil || !district) {
      return res.status(400).json({
        ok: false, error: "गाँव, तहसील और जिला भरें।"
      });
    }

    if (!["all", "doctor", "medical"].includes(type)) {
      return res.status(400).json({ ok: false, error: "गलत खोज प्रकार।" });
    }

    if (!process.env.LANGSEARCH_API_KEY) {
      return res.status(503).json({
        ok: false, error: "ऑनलाइन सर्च API Key सेट नहीं है।"
      });
    }

    const location =
      `"${village}" "${tehsil}" "${district}" "Uttar Pradesh" India`;

    const jobs = [];

    if (type === "all" || type === "doctor") {
      jobs.push(
        langSearch(`doctor clinic physician hospital ${location}`)
          .then(results => ({ category: "doctors", results }))
      );
    }

    if (type === "all" || type === "medical") {
      jobs.push(
        langSearch(`medical store pharmacy chemist medicine shop ${location}`)
          .then(results => ({ category: "medical", results }))
      );
    }

    const completed = await Promise.allSettled(jobs);
    const output = { doctors: [], medical: [], errors: [] };

    for (const item of completed) {
      if (item.status === "rejected") {
        output.errors.push(item.reason?.message || "Search failed");
        continue;
      }

      const category = item.value.category;
      output[category] = item.value.results
        .filter(page => matchesLocation(page, village, district))
        .map(({ text, ...page }) => page);
    }

    res.json({
      ok: true,
      location: { village, tehsil, district, state: "Uttar Pradesh", country: "India" },
      doctors: output.doctors,
      medical: output.medical,
      warning: output.errors.join(" "),
      message: !output.doctors.length && !output.medical.length
        ? "इस गाँव के लिए सत्यापित लोकेशन वाला ऑनलाइन परिणाम नहीं मिला।"
        : ""
    });
  } catch (error) {
    console.error("Online search error:", error.message);
    res.status(502).json({
      ok: false, error: error.message || "ऑनलाइन खोज विफल हुई।"
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on ${PORT}`));
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
