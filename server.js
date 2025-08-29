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

// ===== INIT DB TABLES =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      money INTEGER DEFAULT 0,
      bank_balance INTEGER DEFAULT 0,
      total_crimes INTEGER DEFAULT 0,
      successful_crimes INTEGER DEFAULT 0,
      unsuccessful_crimes INTEGER DEFAULT 0,
      last_crime TIMESTAMP,
      jail_until TIMESTAMP,
      role TEXT DEFAULT 'player'
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crimes (
      id SERIAL PRIMARY KEY,
      name TEXT,
      min_reward INTEGER,
      max_reward INTEGER,
      success_rate REAL,
      cooldown_seconds INTEGER
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cars (
      id SERIAL PRIMARY KEY,
      name TEXT,
      price INTEGER
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_cars (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      car_id INTEGER REFERENCES cars(id),
      condition INTEGER DEFAULT 100
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      name TEXT,
      type TEXT,
      base_price INTEGER,
      owner_id INTEGER REFERENCES users(id)
    )`);

  // Insert starter crimes if empty
  const { rows } = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO crimes (name, min_reward, max_reward, success_rate, cooldown_seconds)
      VALUES
      ('Beg on the streets', 1, 10, 0.9, 10),
      ('Steal a handbag', 20, 100, 0.7, 30),
      ('Rob a pawn shop', 200, 500, 0.5, 60),
      ('Carjacking', 500, 1500, 0.4, 120),
      ('Bank Heist', 2000, 5000, 0.2, 300)
    `);
  }
}
initDB();

// ===== AUTH =====
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING *`,
      [username, hashed]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: "Username taken" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });

  res.json({ success: true, user });
});

// ===== CRIMES =====
app.get("/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes`);
  res.json(result.rows);
});

app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;

  const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userResult.rows[0];

  const crimeResult = await pool.query(`SELECT * FROM crimes WHERE id = $1`, [crimeId]);
  if (crimeResult.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = crimeResult.rows[0];

  if (user.jail_until && new Date(user.jail_until) > new Date()) {
    return res.json({ success: false, message: "You are in jail!", jail_until: user.jail_until });
  }

  if (user.last_crime && new Date(user.last_crime).getTime() + crime.cooldown_seconds * 1000 > Date.now()) {
    return res.json({ success: false, message: "You are cooling down." });
  }

  const success = Math.random() < crime.success_rate;
  let reward = 0, jail_until = null;

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    await pool.query(`
      UPDATE users SET money = money + $1, total_crimes = total_crimes + 1,
      successful_crimes = successful_crimes + 1, last_crime = NOW()
      WHERE id = $2`, [reward, userId]);
  } else {
    jail_until = new Date(Date.now() + crime.cooldown_seconds * 1000);
    await pool.query(`
      UPDATE users SET total_crimes = total_crimes + 1, unsuccessful_crimes = unsuccessful_crimes + 1,
      jail_until = $1, last_crime = NOW() WHERE id = $2`, [jail_until, userId]);
  }

  const updatedUser = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  res.json({ success, reward, jail_until, user: updatedUser.rows[0] });
});

// ===== BANK =====
app.post("/bank/deposit", async (req, res) => {
  const { userId, amount } = req.body;
  const amt = parseInt(amount);
  if (amt <= 0) return res.json({ success: false, message: "Invalid amount" });

  const result = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const user = result.rows[0];
  if (user.money < amt) return res.json({ success: false, message: "Not enough cash" });

  await pool.query(`
    UPDATE users SET money = money - $1, bank_balance = bank_balance + $1 WHERE id = $2`,
    [amt, userId]);

  const updated = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  res.json({ success: true, message: `Deposited $${amt}`, user: updated.rows[0] });
});

app.post("/bank/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  const amt = parseInt(amount);
  if (amt <= 0) return res.json({ success: false, message: "Invalid amount" });

  const result = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const user = result.rows[0];
  if (user.bank_balance < amt) return res.json({ success: false, message: "Not enough in bank" });

  await pool.query(`
    UPDATE users SET money = money + $1, bank_balance = bank_balance - $1 WHERE id = $2`,
    [amt, userId]);

  const updated = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  res.json({ success: true, message: `Withdrew $${amt}`, user: updated.rows[0] });
});

app.post("/bank/transfer", async (req, res) => {
  const { fromUserId, toUsername, amount } = req.body;
  const amt = parseInt(amount);
  if (amt <= 0) return res.json({ success: false, message: "Invalid amount" });

  const sender = await pool.query(`SELECT * FROM users WHERE id = $1`, [fromUserId]);
  if (sender.rows.length === 0) return res.json({ success: false, message: "Sender not found" });

  const user = sender.rows[0];
  if (user.bank_balance < amt) return res.json({ success: false, message: "Not enough balance" });

  const receiver = await pool.query(`SELECT * FROM users WHERE username = $1`, [toUsername]);
  if (receiver.rows.length === 0) return res.json({ success: false, message: "Receiver not found" });

  await pool.query(`UPDATE users SET bank_balance = bank_balance - $1 WHERE id = $2`, [amt, fromUserId]);
  await pool.query(`UPDATE users SET bank_balance = bank_balance + $1 WHERE id = $2`, [amt, receiver.rows[0].id]);

  const updated = await pool.query(`SELECT * FROM users WHERE id = $1`, [fromUserId]);
  res.json({ success: true, message: `Transferred $${amt} to ${toUsername}`, user: updated.rows[0] });
});

// ===== PLACEHOLDER: GARAGE, PROPERTIES, CASINO =====
// You can later expand here.

app.get("/", (req, res) => res.send("✅ Mafia Game API is running!"));

app.listen(4000, () => console.log("Server running on http://localhost:4000"));
