const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DB = path.join(__dirname, "places.json");

// Demo data (nakli naam aur number, sirf test ke liye)
const DEMO = [
  { id: "d1", kind: "dawai", name: "Demo Medical Store", village: "Panduwa", tehsil: "Demo Tehsil", district: "Demo Zila", phone: "9000000001", open: "09:00", close: "21:00", closedDay: "", note: "Raat ki dawai ke liye bell bajao" },
  { id: "d2", kind: "doctor", name: "Dr. Demo Sharma", village: "Panduwa", tehsil: "Demo Tehsil", district: "Demo Zila", phone: "9000000002", open: "10:00", close: "14:00", closedDay: "Sun", note: "General physician" }
];

function load() {
  try { const d = JSON.parse(fs.readFileSync(DB, "utf8")); return Array.isArray(d) ? d : DEMO; }
  catch { return DEMO; }
}
const clean = (v, n = 80) => String(v == null ? "" : v).trim().slice(0, n);
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const has = (field, q) => !q || String(field || "").toLowerCase().includes(q.toLowerCase());

// India ke samay (IST) mein abhi khula hai ya nahi
function isOpenNow(p) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const get = t => parts.find(x => x.type === t).value;
  const day = get("weekday");
  const now = Number(get("hour")) % 24 * 60 + Number(get("minute"));
  if (p.closedDay && p.closedDay === day) return false;
  const [oh, om] = p.open.split(":").map(Number);
  const [ch, cm] = p.close.split(":").map(Number);
  const o = oh * 60 + om, c = ch * 60 + cm;
  return c > o ? now >= o && now < c : now >= o || now < c;
}

// Pehle gaon, nahi mila to usi tehsil, phir usi zila ke record
function findPlaces(all, q) {
  const base = all.filter(p => (!q.kind || p.kind === q.kind) && (!q.onlyOpen || p.openNow));
  let places = base.filter(p => has(p.village, q.village) && has(p.tehsil, q.tehsil) && has(p.district, q.district));
  if (places.length) return { places, level: "gaon" };
  if (q.village && q.tehsil) {
    places = base.filter(p => has(p.tehsil, q.tehsil) && has(p.district, q.district));
    if (places.length) return { places, level: "tehsil" };
  }
  if (q.district) {
    places = base.filter(p => has(p.district, q.district));
    if (places.length) return { places, level: "zila" };
  }
  return { places: [], level: "none" };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/search", (req, res) => {
  const q = {
    village: clean(req.query.village),
    tehsil: clean(req.query.tehsil),
    district: clean(req.query.district),
    kind: clean(req.query.kind),
    onlyOpen: req.query.open === "1"
  };
  if (!q.village && !q.tehsil && !q.district) {
    return res.status(400).json({ error: "Gaon, tehsil ya zila mein se kam se kam ek likho." });
  }

  const all = load().map(p => ({ ...p, openNow: isOpenNow(p) }));
  const { places, level } = findPlaces(all, q);
  places.sort((a, b) => Number(b.openNow) - Number(a.openNow));

  const messages = {
    gaon: places.length + " jagah mili.",
    tehsil: "Aapke gaon ka record nahi mila. Isi tehsil ke ye hain (phone karke pooch lo).",
    zila: "Aapke gaon ya tehsil ka record nahi mila. Isi zila ke ye hain (phone karke pooch lo).",
    none: "Abhi is jagah ka koi record nahi hai. Admin se record jodne ko kaho."
  };
  res.json({
    found: places.length > 0,
    level,
    count: places.length,
    places: places.slice(0, 50),
    message: messages[level]
  });
});

app.post("/api/places", (req, res) => {
  if (!ADMIN_KEY) return res.status(403).json({ error: "Record jodna band hai. Render mein ADMIN_KEY set karo." });
  if (req.get("x-admin-key") !== ADMIN_KEY) return res.status(401).json({ error: "Galat admin key." });
  const b = req.body || {};
  const p = {
    id: Date.now().toString(36),
    kind: b.kind === "doctor" ? "doctor" : "dawai",
    name: clean(b.name), village: clean(b.village), tehsil: clean(b.tehsil), district: clean(b.district),
    phone: clean(b.phone, 15).replace(/[^\d+]/g, ""),
    open: clean(b.open, 5), close: clean(b.close, 5),
    closedDay: DAYS.includes(b.closedDay) ? b.closedDay : "",
    note: clean(b.note, 120)
  };
  if (!p.name || !p.village) return res.status(400).json({ error: "Naam aur gaon zaroori hain." });
  if (!validTime(p.open) || !validTime(p.close)) return res.status(400).json({ error: "Khulne aur band hone ka samay sahi bharo." });
  const list = fs.existsSync(DB) ? load() : [];
  list.push(p);
  fs.writeFileSync(DB, JSON.stringify(list, null, 2));
  res.status(201).json({ ok: true, place: p, message: p.name + " add ho gaya." });
});

app.listen(PORT, () => console.log("Dawai app running on port " + PORT));
