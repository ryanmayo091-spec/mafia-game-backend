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
    role TEXT DEFAULT 'player',
    total_crimes INTEGER DEFAULT 0,
    successful_crimes INTEGER DEFAULT 0,
    unsuccessful_crimes INTEGER DEFAULT 0,
    last_crime TIMESTAMP,
    jail_until TIMESTAMP,
    gang_id INTEGER
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
    bullets INTEGER DEFAULT 0,
    last_production TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS cars (
    id SERIAL PRIMARY KEY,
    model TEXT,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    price INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS blackmarket_items (
    id SERIAL PRIMARY KEY,
    name TEXT,
    price INTEGER,
    seller_id INTEGER REFERENCES users(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS gangs (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE,
    boss_id INTEGER REFERENCES users(id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS gang_wars (
    id SERIAL PRIMARY KEY,
    gang_a INTEGER REFERENCES gangs(id),
    gang_b INTEGER REFERENCES gangs(id),
    winner INTEGER,
    loser INTEGER,
    bullets_used INTEGER,
    war_time TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS casino_config (
    id INT PRIMARY KEY,
    slot_odds REAL,
    blackjack_odds REAL
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS factory_config (
    id INT PRIMARY KEY,
    production_rate INTEGER
  )`);

  // Seed defaults
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

  const casinoConf = await pool.query("SELECT COUNT(*) FROM casino_config");
  if (parseInt(casinoConf.rows[0].count) === 0) {
    await pool.query("INSERT INTO casino_config (id, slot_odds, blackjack_odds) VALUES (1,0.3,0.45)");
  }

  const factoryConf = await pool.query("SELECT COUNT(*) FROM factory_config");
  if (parseInt(factoryConf.rows[0].count) === 0) {
    await pool.query("INSERT INTO factory_config (id, production_rate) VALUES (1,10)");
  }
}
initDB();

// --- Utility ---
async function isAdmin(userId) {
  const result = await pool.query(`SELECT role FROM users WHERE id=$1`, [userId]);
  if (result.rows.length === 0) return false;
  return ["admin", "mod"].includes(result.rows[0].role);
}

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

// --- Bank ---
app.post("/bank/deposit", async (req, res) => {
  const { userId, amount } = req.body;
  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user || amount <= 0 || user.money < amount)
    return res.status(400).json({ error: "Invalid deposit" });

  await pool.query(`UPDATE users SET money=money-$1, bank_balance=bank_balance+$1 WHERE id=$2`, [amount, userId]);
  const updated = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json({ success: true, user: updated.rows[0] });
});

app.post("/bank/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user || amount <= 0 || user.bank_balance < amount)
    return res.status(400).json({ error: "Invalid withdraw" });

  await pool.query(`UPDATE users SET money=money+$1, bank_balance=bank_balance-$1 WHERE id=$2`, [amount, userId]);
  const updated = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json({ success: true, user: updated.rows[0] });
});

// --- Garage ---
app.get("/garage/:userId", async (req, res) => {
  const cars = await pool.query(`SELECT * FROM cars WHERE owner_id=$1`, [req.params.userId]);
  res.json(cars.rows);
});

// (buy/sell cars omitted here for brevity — still in previous version)

// --- Casino ---
app.post("/casino/slots", async (req, res) => {
  const { userId } = req.body;
  const conf = await pool.query("SELECT * FROM casino_config WHERE id=1");
  const odds = conf.rows[0]?.slot_odds || 0.3;

  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user || user.money < 100) return res.json({ success: false, message: "Need $100" });

  await pool.query(`UPDATE users SET money=money-100 WHERE id=$1`, [userId]);
  if (Math.random() < odds) {
    await pool.query(`UPDATE users SET money=money+500 WHERE id=$1`, [userId]);
    return res.json({ success: true, message: "🎰 JACKPOT!" });
  }
  res.json({ success: false, message: "🎰 Lost this spin." });
});

// --- Admin: Users ---
app.get("/admin/users/:adminId", async (req, res) => {
  if (!(await isAdmin(req.params.adminId))) return res.status(403).json({ error: "Not authorized" });
  const users = await pool.query(`SELECT id, username, money, bank_balance, bullets, role FROM users`);
  res.json(users.rows);
});

app.post("/admin/update-user", async (req, res) => {
  const { adminId, targetId, money, bullets, role } = req.body;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });
  await pool.query(`UPDATE users SET money=$1, bullets=$2, role=$3 WHERE id=$4`, [money, bullets, role, targetId]);
  res.json({ success: true });
});

// --- Admin: Economy ---
app.get("/admin/economy/:adminId", async (req, res) => {
  if (!(await isAdmin(req.params.adminId))) return res.status(403).json({ error: "Not authorized" });
  const crimes = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  const factory = await pool.query(`SELECT * FROM factory_config WHERE id=1`);
  res.json({ crimes: crimes.rows, factory: factory.rows[0] });
});

app.post("/admin/update-crime", async (req, res) => {
  const { adminId, crimeId, min_reward, max_reward, success_rate, cooldown_seconds } = req.body;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });
  await pool.query(`UPDATE crimes SET min_reward=$1,max_reward=$2,success_rate=$3,cooldown_seconds=$4 WHERE id=$5`,
    [min_reward, max_reward, success_rate, cooldown_seconds, crimeId]);
  res.json({ success: true });
});

app.post("/admin/update-bullet-factory", async (req, res) => {
  const { adminId, production_rate } = req.body;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });
  await pool.query(`INSERT INTO factory_config (id, production_rate) VALUES (1,$1)
                    ON CONFLICT (id) DO UPDATE SET production_rate=$1`, [production_rate]);
  res.json({ success: true });
});

// Root
app.get("/", (_, res) => res.send("✅ Mafia Game API running!"));

app.listen(4000, () => console.log("Server running on http://localhost:4000"));
