import express from "express";
import pkg from "pg";
import bcrypt from "bcrypt";
import bodyParser from "body-parser";
import cors from "cors";

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// === Init DB ===
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    pocket_money INTEGER DEFAULT 0,
    bank_money INTEGER DEFAULT 0,
    dirty_money INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0,
    rank TEXT DEFAULT 'Street Thug',
    total_crimes INTEGER DEFAULT 0,
    successful_crimes INTEGER DEFAULT 0,
    unsuccessful_crimes INTEGER DEFAULT 0,
    jail_until TIMESTAMP,
    last_crimes JSONB DEFAULT '{}'
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS crimes (
    id SERIAL PRIMARY KEY,
    name TEXT,
    description TEXT,
    category TEXT,
    min_reward INTEGER,
    max_reward INTEGER,
    success_rate REAL,
    cooldown_seconds INTEGER,
    xp_reward INTEGER DEFAULT 0
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS cars (
    id SERIAL PRIMARY KEY,
    name TEXT,
    price INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS ranks (
    id SERIAL PRIMARY KEY,
    name TEXT,
    xp_required INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS investments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    type TEXT,
    amount INTEGER,
    return_percent REAL,
    risk REAL,
    complete_at TIMESTAMP,
    collected BOOLEAN DEFAULT false
  )`);

  // seed ranks if empty
  const rankCount = await pool.query("SELECT COUNT(*) FROM ranks");
  if (parseInt(rankCount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO ranks (name, xp_required) VALUES
      ('Street Thug', 0),
      ('Gangster', 100),
      ('Capo', 500),
      ('Boss', 2000),
      ('Don', 5000),
      ('Godfather', 10000)`
    );
  }
}
initDB();

// === Helper: Rank Update ===
async function updateUserRank(userId) {
  const userRes = await pool.query("SELECT xp FROM users WHERE id=$1", [userId]);
  if (userRes.rows.length === 0) return;
  const xp = userRes.rows[0].xp;
  const rankRes = await pool.query(
    "SELECT name FROM ranks WHERE xp_required <= $1 ORDER BY xp_required DESC LIMIT 1",
    [xp]
  );
  if (rankRes.rows.length > 0) {
    const newRank = rankRes.rows[0].name;
    await pool.query("UPDATE users SET rank=$1 WHERE id=$2", [newRank, userId]);
  }
}

// === Auth Routes ===
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING *`,
      [username, hashed]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch {
    res.status(400).json({ success: false, error: "Username taken" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
  if (result.rows.length === 0) return res.json({ success: false, error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.json({ success: false, error: "Invalid password" });

  res.json({ success: true, user });
});

// === Crimes ===
app.get("/crimes", async (req, res) => {
  const crimes = await pool.query("SELECT * FROM crimes ORDER BY category, id");
  res.json(crimes.rows);
});

app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;
  const userRes = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
  if (userRes.rows.length === 0) return res.json({ success: false, error: "User not found" });
  const user = userRes.rows[0];

  const crimeRes = await pool.query("SELECT * FROM crimes WHERE id=$1", [crimeId]);
  if (crimeRes.rows.length === 0) return res.json({ success: false, error: "Crime not found" });
  const crime = crimeRes.rows[0];

  const lastCrimes = user.last_crimes || {};
  const now = Date.now();
  const cooldownEnd = lastCrimes[crimeId]
    ? new Date(lastCrimes[crimeId]).getTime() + crime.cooldown_seconds * 1000
    : 0;
  if (now < cooldownEnd) return res.json({ success: false, message: "Crime cooling down" });

  const success = Math.random() < crime.success_rate;
  let reward = 0, jailUntil = null;

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;

    // half clean, half dirty
    const clean = Math.floor(reward * 0.5);
    const dirty = reward - clean;

    await pool.query(
      `UPDATE users SET pocket_money=pocket_money+$1, dirty_money=dirty_money+$2, xp=xp+$3,
       total_crimes=total_crimes+1, successful_crimes=successful_crimes+1,
       last_crimes=jsonb_set(last_crimes, $4, to_jsonb(NOW()), true) WHERE id=$5`,
      [clean, dirty, crime.xp_reward || 5, `{${crimeId}}`, userId]
    );
  } else {
    jailUntil = new Date(now + crime.cooldown_seconds * 1000);
    await pool.query(
      `UPDATE users SET xp=xp+1, total_crimes=total_crimes+1, unsuccessful_crimes=unsuccessful_crimes+1,
       jail_until=$1, last_crimes=jsonb_set(last_crimes, $2, to_jsonb(NOW()), true) WHERE id=$3`,
      [jailUntil, `{${crimeId}}`, userId]
    );
  }

  await updateUserRank(userId);
  const updatedUser = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
  res.json({ success, reward, jail_until: jailUntil, user: updatedUser.rows[0] });
});

// === Bank 2.0 ===
app.post("/bank/deposit", async (req, res) => {
  const { userId, amount } = req.body;
  const fee = Math.floor(amount * 0.05);
  await pool.query(
    `UPDATE users SET pocket_money=pocket_money-$1, bank_money=bank_money+($1-$2)
     WHERE id=$3 AND pocket_money >= $1`,
    [amount, fee, userId]
  );
  res.json({ success: true, message: `Deposited $${amount} (5% fee taken)` });
});

app.post("/bank/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  await pool.query(
    `UPDATE users SET pocket_money=pocket_money+$1, bank_money=bank_money-$1
     WHERE id=$2 AND bank_money >= $1`,
    [amount, userId]
  );
  res.json({ success: true, message: `Withdrew $${amount}` });
});

app.post("/bank/launder", async (req, res) => {
  const { userId, amount } = req.body;
  const fee = Math.floor(amount * 0.1);
  await pool.query(
    `UPDATE users SET dirty_money=dirty_money-$1, bank_money=bank_money+($1-$2)
     WHERE id=$3 AND dirty_money >= $1`,
    [amount, fee, userId]
  );
  res.json({ success: true, message: `Laundered $${amount} dirty money (10% fee)` });
});

app.post("/bank/invest", async (req, res) => {
  const { userId, type, amount } = req.body;
  let returnPercent = 0.05, risk = 0.0, hours = 24;

  if (type === "bonds") { returnPercent = 0.05; risk = 0; hours = 24; }
  if (type === "business") { returnPercent = 0.25; risk = 0.3; hours = 72; }
  if (type === "loan-shark") { returnPercent = 1.0; risk = 0.5; hours = 168; }

  const completeAt = new Date(Date.now() + hours * 3600 * 1000);
  await pool.query(
    `INSERT INTO investments (user_id, type, amount, return_percent, risk, complete_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, type, amount, returnPercent, risk, completeAt]
  );
  await pool.query("UPDATE users SET bank_money=bank_money-$1 WHERE id=$2 AND bank_money >= $1", [amount, userId]);

  res.json({ success: true, message: `Invested $${amount} into ${type}` });
});

app.post("/bank/collect-investment", async (req, res) => {
  const { investmentId } = req.body;
  const invRes = await pool.query("SELECT * FROM investments WHERE id=$1", [investmentId]);
  if (invRes.rows.length === 0) return res.json({ success: false, error: "Not found" });

  const inv = invRes.rows[0];
  if (new Date(inv.complete_at) > new Date()) return res.json({ success: false, error: "Not ready yet" });
  if (inv.collected) return res.json({ success: false, error: "Already collected" });

  const success = Math.random() > inv.risk;
  let payout = 0;
  if (success) payout = Math.floor(inv.amount * (1 + inv.return_percent));

  await pool.query("UPDATE investments SET collected=true WHERE id=$1", [investmentId]);
  if (payout > 0) await pool.query("UPDATE users SET bank_money=bank_money+$1 WHERE id=$2", [payout, inv.user_id]);

  res.json({ success, payout, message: success ? `You earned $${payout}` : "Investment failed!" });
});

// === Garage ===
app.get("/garage/:userId", async (req, res) => {
  const cars = await pool.query("SELECT * FROM cars");
  res.json(cars.rows);
});

// === Rankings ===
app.get("/rankings", async (req, res) => {
  const top = await pool.query("SELECT username, xp, money, rank FROM users ORDER BY xp DESC, bank_money DESC LIMIT 20");
  res.json(top.rows);
});

// === Root ===
app.get("/", (req, res) => res.send("✅ Mafia API Running with Bank 2.0"));

app.listen(4000, () => console.log("🚀 Server running on http://localhost:4000"));
