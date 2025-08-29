import express from "express";
import pkg from "pg";
import bcrypt from "bcrypt";
import bodyParser from "body-parser";
import cors from "cors";

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(bodyParser.json());

// Connect to Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// === Initialize Tables ===
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    money INTEGER DEFAULT 0,
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
    xp_reward INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS cars (
    id SERIAL PRIMARY KEY,
    name TEXT,
    price INTEGER
  )`);

  // Seed crimes if empty
  const crimeCount = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(crimeCount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO crimes (name, description, category, min_reward, max_reward, success_rate, cooldown_seconds, xp_reward)
       VALUES 
       ('Beg on the streets', 'Spare change from strangers.', 'Petty', 1, 10, 0.9, 10, 2),
       ('Pickpocket', 'Lift a wallet without being caught.', 'Petty', 5, 50, 0.6, 30, 5),
       ('Mugging', 'Confront someone in a dark alley.', 'Street', 50, 200, 0.5, 60, 10),
       ('Store Robbery', 'Rob a small convenience store.', 'Street', 200, 800, 0.4, 120, 20),
       ('Bank Heist', 'Attempt a daring bank robbery.', 'Heist', 5000, 20000, 0.2, 600, 100)`
    );
  }

  // Seed cars if empty
  const carCount = await pool.query("SELECT COUNT(*) FROM cars");
  if (parseInt(carCount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO cars (name, price) VALUES
      ('Stolen Bike', 100),
      ('Rusty Sedan', 500),
      ('Muscle Car', 5000),
      ('Luxury Limo', 20000)`
    );
  }
}
initDB();

// === Routes ===

// Register
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
    res.status(400).json({ success: false, error: "Username taken" });
  }
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
  if (result.rows.length === 0) return res.json({ success: false, error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.json({ success: false, error: "Invalid password" });

  res.json({ success: true, user });
});

// Get crimes
app.get("/crimes", async (req, res) => {
  const crimes = await pool.query("SELECT * FROM crimes ORDER BY category, id");
  res.json(crimes.rows);
});

// Commit crime
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
  if (now < cooldownEnd) {
    return res.json({ success: false, message: "Crime still cooling down" });
  }

  const success = Math.random() < crime.success_rate;
  let reward = 0;
  let jailUntil = null;

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    await pool.query(
      `UPDATE users SET money=money+$1, xp=xp+$2, total_crimes=total_crimes+1, successful_crimes=successful_crimes+1,
       last_crimes = jsonb_set(last_crimes, $3, to_jsonb(NOW()), true)
       WHERE id=$4`,
      [reward, crime.xp_reward || 5, `{${crimeId}}`, userId]
    );
  } else {
    jailUntil = new Date(now + crime.cooldown_seconds * 1000);
    await pool.query(
      `UPDATE users SET xp=xp+1, total_crimes=total_crimes+1, unsuccessful_crimes=unsuccessful_crimes+1,
       jail_until=$1,
       last_crimes = jsonb_set(last_crimes, $2, to_jsonb(NOW()), true)
       WHERE id=$3`,
      [jailUntil, `{${crimeId}}`, userId]
    );
  }

  const updatedUser = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);

  res.json({
    success,
    reward,
    message: success ? `You earned $${reward}` : "You failed and got jailed!",
    jail_until: jailUntil,
    user: updatedUser.rows[0],
  });
});

// Bank
app.post("/bank/deposit", async (req, res) => {
  const { userId, amount } = req.body;
  await pool.query("UPDATE users SET money=money-$1 WHERE id=$2 AND money >= $1", [amount, userId]);
  res.json({ success: true, message: `Deposited $${amount}` });
});

app.post("/bank/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  await pool.query("UPDATE users SET money=money+$1 WHERE id=$2", [amount, userId]);
  res.json({ success: true, message: `Withdrew $${amount}` });
});

// Garage
app.get("/garage/:userId", async (req, res) => {
  const cars = await pool.query("SELECT * FROM cars");
  res.json(cars.rows);
});

// Rankings
app.get("/rankings", async (req, res) => {
  const top = await pool.query("SELECT username, xp, money FROM users ORDER BY xp DESC, money DESC LIMIT 20");
  res.json(top.rows);
});

// Root
app.get("/", (req, res) => res.send("✅ Mafia API Running"));

app.listen(4000, () => console.log("🚀 Server running on http://localhost:4000"));
