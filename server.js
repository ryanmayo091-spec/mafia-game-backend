// server.js
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

// --- DB Init ---
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    money INTEGER DEFAULT 0,
    bank_balance INTEGER DEFAULT 0,
    bullets INTEGER DEFAULT 0,
    total_crimes INTEGER DEFAULT 0,
    successful_crimes INTEGER DEFAULT 0,
    unsuccessful_crimes INTEGER DEFAULT 0,
    last_crime TIMESTAMP,
    jail_until TIMESTAMP,
    gang_id INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS gangs (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE,
    boss_id INTEGER REFERENCES users(id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS crimes (
    id SERIAL PRIMARY KEY,
    name TEXT,
    min_reward INTEGER,
    max_reward INTEGER,
    success_rate REAL,
    cooldown_seconds INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS properties (
    id SERIAL PRIMARY KEY,
    name TEXT,
    base_price INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_properties (
    id SERIAL PRIMARY KEY,
    property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    custom_price INTEGER,
    is_for_sale BOOLEAN DEFAULT false,
    sale_price INTEGER,
    bullets INTEGER DEFAULT 0,
    last_production TIMESTAMP DEFAULT NOW()
  )`);

  // Insert defaults
  const crimesCount = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(crimesCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO crimes (name, min_reward, max_reward, success_rate, cooldown_seconds)
      VALUES
      ('Beg on the streets', 1, 10, 0.9, 10),
      ('Pickpocket', 5, 20, 0.75, 20),
      ('Rob a shop', 20, 100, 0.6, 30),
      ('Car theft', 100, 500, 0.4, 60),
      ('Bank heist', 1000, 5000, 0.2, 120)
    `);
  }

  const propsCount = await pool.query("SELECT COUNT(*) FROM properties");
  if (parseInt(propsCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO properties (name, base_price) VALUES
      ('Bullet Factory', 10000),
      ('Casino', 50000),
      ('Nightclub', 20000)
    `);
  }
}
initDB();

// --- Auth ---
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`,
      [username, hashed]
    );
    res.json({ success: true, userId: result.rows[0].id });
  } catch {
    res.status(400).json({ error: "Username taken" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
  if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });

  res.json({ success: true, user });
});

// --- Crimes ---
app.get("/crimes", async (_, res) => {
  const result = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(result.rows);
});

// --- Bullet Factory ---
async function updateBulletFactory(factoryId) {
  const res = await pool.query(`SELECT * FROM user_properties WHERE id=$1`, [factoryId]);
  if (res.rows.length === 0) return null;
  const f = res.rows[0];

  const now = new Date();
  const last = new Date(f.last_production || new Date());
  const minutes = Math.floor((now - last) / (1000 * 60));
  if (minutes > 0) {
    const produced = minutes * 2;
    const newStock = (f.bullets || 0) + produced;
    await pool.query(
      `UPDATE user_properties SET bullets=$1, last_production=NOW() WHERE id=$2`,
      [newStock, factoryId]
    );
  }

  const updated = await pool.query(`SELECT * FROM user_properties WHERE id=$1`, [factoryId]);
  return updated.rows[0];
}

app.post("/factory/buy", async (req, res) => {
  const { userId, propertyId, amount } = req.body;
  const factory = await updateBulletFactory(propertyId);
  if (!factory || factory.bullets < amount) return res.status(400).json({ error: "Not enough stock" });

  const price = (factory.custom_price || 100) * amount;
  const buyerRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const buyer = buyerRes.rows[0];
  if (buyer.money < price) return res.status(400).json({ error: "Not enough money" });

  await pool.query(`UPDATE users SET money=money-$1, bullets=bullets+$2 WHERE id=$3`, [price, amount, userId]);
  await pool.query(`UPDATE users SET money=money+$1 WHERE id=$2`, [price, factory.owner_id]);
  await pool.query(`UPDATE user_properties SET bullets=bullets-$1 WHERE id=$2`, [amount, propertyId]);

  res.json({ success: true, bulletsBought: amount, cost: price });
});

// --- PvP Attacks ---
app.post("/attack", async (req, res) => {
  const { attackerId, defenderId, bulletsUsed } = req.body;
  const attackerRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [attackerId]);
  const defenderRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [defenderId]);
  if (attackerRes.rows.length === 0 || defenderRes.rows.length === 0) return res.status(404).json({ error: "Player not found" });

  const attacker = attackerRes.rows[0];
  const defender = defenderRes.rows[0];
  if (attacker.bullets < bulletsUsed) return res.status(400).json({ error: "Not enough bullets" });

  await pool.query(`UPDATE users SET bullets=bullets-$1 WHERE id=$2`, [bulletsUsed, attackerId]);

  const chance = Math.min(0.9, bulletsUsed / 100);
  const win = Math.random() < chance;

  if (win) {
    const stolen = Math.floor(defender.money * 0.1);
    await pool.query(`UPDATE users SET money=money-$1 WHERE id=$2`, [stolen, defenderId]);
    await pool.query(`UPDATE users SET money=money+$1 WHERE id=$2`, [stolen, attackerId]);
    return res.json({ success: true, message: `Attack successful! Stole $${stolen}` });
  } else {
    return res.json({ success: false, message: "Attack failed! Bullets wasted." });
  }
});

// --- Gangs ---
app.post("/gang/create", async (req, res) => {
  const { bossId, name } = req.body;
  try {
    const gangRes = await pool.query(`INSERT INTO gangs (name, boss_id) VALUES ($1,$2) RETURNING id`, [name, bossId]);
    await pool.query(`UPDATE users SET gang_id=$1 WHERE id=$2`, [gangRes.rows[0].id, bossId]);
    res.json({ success: true, gangId: gangRes.rows[0].id });
  } catch {
    res.status(400).json({ error: "Gang name taken" });
  }
});

app.post("/gang/join", async (req, res) => {
  const { userId, gangId } = req.body;
  await pool.query(`UPDATE users SET gang_id=$1 WHERE id=$2`, [gangId, userId]);
  res.json({ success: true });
});

app.post("/gang/war", async (req, res) => {
  const { gangA, gangB, bulletsUsed, initiatorId } = req.body;
  const attackerRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [initiatorId]);
  if (attackerRes.rows.length === 0) return res.status(404).json({ error: "User not found" });

  const attacker = attackerRes.rows[0];
  if (attacker.bullets < bulletsUsed) return res.status(400).json({ error: "Not enough bullets" });

  await pool.query(`UPDATE users SET bullets=bullets-$1 WHERE id=$2`, [bulletsUsed, initiatorId]);

  const chance = Math.min(0.9, bulletsUsed / 500); // 500 bullets = max 90%
  const win = Math.random() < chance;

  if (win) {
    await pool.query(`UPDATE gangs SET boss_id=$1 WHERE id=$2`, [initiatorId, gangB]);
    res.json({ success: true, message: `Gang ${gangA} defeated ${gangB}! Turf captured.` });
  } else {
    res.json({ success: false, message: "Gang war lost! Bullets wasted." });
  }
});

// Root
app.get("/", (_, res) => res.send("✅ Mafia Game API running!"));

app.listen(4000, () => console.log("Server running http://localhost:4000"));
