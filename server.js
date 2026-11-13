
const express = require("express");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!DATABASE_URL || !ADMIN_KEY) {
  console.error("DATABASE_URL या ADMIN_KEY missing है।");
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "30kb" }));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : undefined
});

const limiter = rateLimit({
  windowMs: 60000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS places (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      type VARCHAR(20) NOT NULL
        CHECK(type IN ('doctor','medical')),
      village VARCHAR(120) NOT NULL,
      tehsil VARCHAR(120) NOT NULL,
      district VARCHAR(120) NOT NULL,
      address TEXT DEFAULT '',
      phone VARCHAR(20) DEFAULT '',
      open_time TIME,
      close_time TIME,
      open_days INTEGER[] NOT NULL
        DEFAULT ARRAY[0,1,2,3,4,5,6],
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS places_location_idx
    ON places
    (LOWER(village),LOWER(tehsil),LOWER(district),type)
  `);

  console.log("Database ready");
}

function adminAuth(req,res,next) {
  const key = req.get("x-admin-key") || "";
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);

  if (a.length !== b.length ||
      !crypto.timingSafeEqual(a,b)) {
    return res.status(401).json({
      message:"Admin key गलत है।"
    });
  }
  next();
}

app.get("/api/health", async(req,res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ok:true,database:"connected"});
  } catch(error) {
    console.error(error);
    res.status(503).json({
      ok:false,database:"disconnected"
    });
  }
});

app.get("/api/search",limiter,async(req,res) => {
  const village = String(req.query.village || "").trim();
  const tehsil = String(req.query.tehsil || "").trim();
  const district = String(req.query.district || "").trim();
  const type = String(req.query.type || "all");

  if (!village || !tehsil || !district) {
    return res.status(400).json({
      message:"गाँव, तहसील और जिला भरें।",
      results:[]
    });
  }

  if (!["all","doctor","medical"].includes(type)) {
    return res.status(400).json({
      message:"खोज का प्रकार सही नहीं है।",
      results:[]
    });
  }

  try {
    const values = [
      `%${village}%`,
      `%${tehsil}%`,
      `%${district}%`
    ];

    let sql = `
      SELECT id,name,type,village,tehsil,district,
      address,phone,open_time::text,close_time::text
      FROM places
      WHERE village ILIKE $1
      AND tehsil ILIKE $2
      AND district ILIKE $3
    `;

    if(type !== "all") {
      values.push(type);
      sql += ` AND type = $${values.length}`;
    }

    sql += " ORDER BY name LIMIT 100";

    const result = await pool.query(sql,values);

    res.json({
      message:result.rows.length
        ? `${result.rows.length} परिणाम मिले।`
        : "इस क्षेत्र में कोई जानकारी नहीं मिली।",
      count:result.rows.length,
      results:result.rows
    });

  } catch(error) {
    console.error("Search error:",error);
    res.status(500).json({
      message:"सर्वर में खोज की समस्या आई।",
      results:[]
    });
  }
});

app.post("/api/places",adminAuth,async(req,res) => {
  const {
    name,type,village,tehsil,district,
    address="",phone="",openTime=null,
    closeTime=null
  } = req.body || {};

  if(!name || !village || !tehsil || !district ||
     !["doctor","medical"].includes(type)) {
    return res.status(400).json({
      message:"सभी जरूरी जानकारी सही भरें।"
    });
  }

  try {
    const result = await pool.query(`
      INSERT INTO places
      (name,type,village,tehsil,district,address,
       phone,open_time,close_time)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `,[
      name,type,village,tehsil,district,
      address,phone,openTime,closeTime
    ]);

    res.status(201).json({
      message:"जानकारी सफलतापूर्वक सेव हो गई।",
      place:result.rows[0]
    });

  } catch(error) {
    console.error(error);
    res.status(500).json({
      message:"Database में जानकारी सेव नहीं हुई।"
    });
  }
});

app.get("/",(req,res) => {
  res.sendFile(path.join(__dirname,"index.html"));
});

app.use((req,res) => {
  res.status(404).json({
    message:"Page या API नहीं मिला।"
  });
});

initDB().then(() => {
  app.listen(PORT,() => {
    console.log("Server running on port",PORT);
  });
}).catch(error => {
  console.error("Database initialization failed:",error);
  process.exit(1);
});

process.on("SIGTERM",async() => {
  await pool.end();
  process.exit(0);
});
