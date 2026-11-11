const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // Render Environment mein set karo
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
  return c > o ? now >= o && now < c : now >= o || now < c; // raat ko paar karne wala samay
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/search", (req, res) => {
  const village = clean(req.query.village).toLowerCase();
  const kind = clean(req.query.kind);
  const onlyOpen = req.query.open === "1";
  let list = load().map(p => ({ ...p, openNow: isOpenNow(p) }));
  list = list.filter(p =>
    (!village || p.village.toLowerCase().includes(village)) &&
    (!kind || p.kind === kind) &&
    (!onlyOpen || p.openNow));
  list.sort((a, b) => Number(b.openNow) - Number(a.openNow));
  res.json({
    found: list.length > 0,
    count: list.length,
    places: list.slice(0, 50),
    message: list.length ? list.length + " jagah mili." : "Is jagah par abhi koi record nahi mila."
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
