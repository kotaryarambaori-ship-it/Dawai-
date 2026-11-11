const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const CONTACT = process.env.CONTACT_EMAIL || "apna-email@example.com"; // OpenStreetMap ko batane ke liye
const UA = "DawaiDoctorApp/1.0 (" + CONTACT + ")";
const DB = path.join(__dirname, "places.json");

// Demo data (nakli naam aur number, sirf test ke liye)
const DEMO = [
  { id: "d1", kind: "dawai", name: "Demo Medical Store", village: "Panduwa", phone: "9000000001", open: "09:00", close: "21:00", closedDay: "", note: "Raat ki dawai ke liye bell bajao" },
  { id: "d2", kind: "doctor", name: "Dr. Demo Sharma", village: "Panduwa", phone: "9000000002", open: "10:00", close: "14:00", closedDay: "Sun", note: "General physician" }
];

function load() {
  try { const d = JSON.parse(fs.readFileSync(DB, "utf8")); return Array.isArray(d) ? d : DEMO; }
  catch { return DEMO; }
}
const clean = (v, n = 80) => String(v == null ? "" : v).trim().slice(0, n);
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

// OpenStreetMap se gaon ke 10 km aas-paas ki dukan aur doctors
const cache = new Map();
async function osmSearch(village, kind) {
  const key = village.toLowerCase() + "|" + kind;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.data;
  try {
    const g = await fetch(
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=" + encodeURIComponent(village),
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    const geo = await g.json();
    if (!geo.length) return [];
    const types = kind === "dawai" ? "pharmacy" : kind === "doctor" ? "doctors|clinic|hospital" : "pharmacy|doctors|clinic|hospital";
    const q = `[out:json][timeout:15];nwr["amenity"~"^(${types})$"](around:10000,${geo[0].lat},${geo[0].lon});out center 40;`;
    const o = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
      signal: AbortSignal.timeout(20000)
    });
    const data = await o.json();
    const places = (data.elements || []).filter(e => e.tags && e.tags.name).map(e => ({
      id: "osm" + e.id,
      kind: e.tags.amenity === "pharmacy" ? "dawai" : "doctor",
      name: e.tags.name,
      village: "Aas-paas (10 km)",
      phone: (e.tags.phone || e.tags["contact:phone"] || "").replace(/[^\d+]/g, ""),
      open: "", close: "", closedDay: "",
      note: e.tags.opening_hours ? "Samay: " + e.tags.opening_hours : "Samay pata nahi, phone karke pooch lo",
      openNow: null, source: "osm"
    }));
    cache.set(key, { t: Date.now(), data: places });
    return places;
  } catch { return []; }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/search", async (req, res) => {
  const village = clean(req.query.village);
  const kind = clean(req.query.kind);
  const onlyOpen = req.query.open === "1";

  const own = load()
    .map(p => ({ ...p, openNow: isOpenNow(p) }))
    .filter(p => (!village || p.village.toLowerCase().includes(village.toLowerCase())) &&
                 (!kind || p.kind === kind) && (!onlyOpen || p.openNow));
  own.sort((a, b) => Number(b.openNow) - Number(a.openNow));

  const osm = village && !onlyOpen ? await osmSearch(village, kind) : [];
  const names = new Set(own.map(p => p.name.toLowerCase()));
  const list = own.concat(osm.filter(p => !names.has(p.name.toLowerCase())));

  res.json({
    found: list.length > 0,
    count: list.length,
    places: list.slice(0, 50),
    message: list.length ? list.length + " jagah mili." : "Is gaon ke paas koi record nahi mila."
  });
});

app.post("/api/places", (req, res) => {
  if (!ADMIN_KEY) return res.status(403).json({ error: "Record jodna band hai. Render mein ADMIN_KEY set karo." });
  if (req.get("x-admin-key") !== ADMIN_KEY) return res.status(401).json({ error: "Galat admin key." });
  const b = req.body || {};
  const p = {
    id: Date.now().toString(36),
    kind: b.kind === "doctor" ? "doctor" : "dawai",
    name: clean(b.name), village: clean(b.village), phone: clean(b.phone, 15).replace(/[^\d+]/g, ""),
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
