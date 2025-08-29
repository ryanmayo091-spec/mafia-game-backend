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
      jail_until TIMESTAMP,
      role TEXT DEFAULT 'player'
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crimes (
      id SERIAL PRIMARY KEY,
      name TEXT,
      description TEXT,
      min_reward INTEGER,
      max_reward INTEGER,
      success_rate REAL,
      cooldown_seconds INTEGER,
      unlock_requirement INTEGER DEFAULT 0
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_crime_cooldowns (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      crime_id INTEGER REFERENCES crimes(id),
      available_at TIMESTAMP
    )`);

  // Insert starter crimes if empty
  const { rows } = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO crimes (name, description, min_reward, max_reward, success_rate, cooldown_seconds, unlock_requirement)
      VALUES
      ('Beg on the Streets', 'Ask strangers for spare change.', 1, 10, 0.9, 10, 0),
      ('Pickpocket', 'Lift wallets from unsuspecting pedestrians.', 20, 100, 0.75, 30, 5),
      ('Rob a Pawn Shop', 'Smash and grab jewelry or electronics.', 200, 500, 0.55, 60, 20),
      ('Carjacking', 'Steal a parked car and sell it fast.', 500, 1500, 0.4, 120, 50),
      ('Bank Heist', 'Plan a daring robbery on a local bank.', 2000, 5000, 0.2, 300, 200)
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

  // fetch cooldowns
  const cooldowns = await pool.query(
    `SELECT crime_id, available_at FROM user_crime_cooldowns WHERE user_id=$1`,
    [user.id]
  );

  res.json({
    success: true,
    user: { ...user, cooldowns: Object.fromEntries(cooldowns.rows.map(r => [r.crime_id, r.available_at])) }
  });
});

// ===== CRIMES =====
app.get("/crimes/:userId", async (req, res) => {
  const { userId } = req.params;
  const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (user.rows.length === 0) return res.status(404).json({ error: "User not found" });

  const total = user.rows[0].total_crimes;
  const crimes = await pool.query(`SELECT * FROM crimes WHERE unlock_requirement <= $1 ORDER BY id`, [total]);
  res.json(crimes.rows);
});

app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;

  const userResult = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userResult.rows[0];

  const crimeResult = await pool.query(`SELECT * FROM crimes WHERE id=$1`, [crimeId]);
  if (crimeResult.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = crimeResult.rows[0];

  // jail check
  if (user.jail_until && new Date(user.jail_until) > new Date()) {
    return res.json({ success: false, message: "You are in jail!", jail_until: user.jail_until });
  }

  // cooldown check
  const cooldownResult = await pool.query(
    `SELECT * FROM user_crime_cooldowns WHERE user_id=$1 AND crime_id=$2`,
    [userId, crimeId]
  );
  if (cooldownResult.rows.length > 0) {
    const availableAt = new Date(cooldownResult.rows[0].available_at);
    if (availableAt > new Date()) {
      const wait = Math.ceil((availableAt - new Date()) / 1000);
      return res.json({ success: false, message: `Wait ${wait}s before trying this crime again.` });
    }
  }

  // outcome roll
  const roll = Math.random();
  let success = false, reward = 0, jail_until = null, story = "";

  if (roll < crime.success_rate * 0.1) {
    success = true;
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    reward *= 2; // critical
    story = `💎 Critical Success! You pulled off ${crime.name} flawlessly and earned $${reward}.`;
  } else if (roll < crime.success_rate) {
    success = true;
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    story = `✅ You succeeded in ${crime.name} and got $${reward}.`;
  } else if (roll < 0.9) {
    success = false;
    story = `❌ You failed while attempting ${crime.name}. You escaped but earned nothing.`;
  } else {
    success = false;
    jail_until = new Date(Date.now() + crime.cooldown_seconds * 1000);
    await pool.query(`UPDATE users SET jail_until=$1 WHERE id=$2`, [jail_until, userId]);
    story = `🚔 You got caught during ${crime.name} and are in jail until ${jail_until.toLocaleTimeString()}.`;
  }

  // update user stats & money
  if (success) {
    await pool.query(`
      UPDATE users SET money=money+$1, total_crimes=total_crimes+1, successful_crimes=successful_crimes+1 WHERE id=$2
    `, [reward, userId]);
  } else {
    await pool.query(`
      UPDATE users SET total_crimes=total_crimes+1, unsuccessful_crimes=unsuccessful_crimes+1 WHERE id=$1
    `, [userId]);
  }

  // update cooldown for this crime
  const nextAvailable = new Date(Date.now() + crime.cooldown_seconds * 1000);
  if (cooldownResult.rows.length > 0) {
    await pool.query(`UPDATE user_crime_cooldowns SET available_at=$1 WHERE user_id=$2 AND crime_id=$3`,
      [nextAvailable, userId, crimeId]);
  } else {
    await pool.query(`INSERT INTO user_crime_cooldowns (user_id, crime_id, available_at) VALUES ($1,$2,$3)`,
      [userId, crimeId, nextAvailable]);
  }

  // return updated user
  const updated = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const cooldowns = await pool.query(`SELECT crime_id, available_at FROM user_crime_cooldowns WHERE user_id=$1`, [userId]);

  res.json({
    success,
    reward,
    story,
    jail_until,
    user: { ...updated.rows[0], cooldowns: Object.fromEntries(cooldowns.rows.map(r => [r.crime_id, r.available_at])) }
  });
});

// ===== ROOT =====
app.get("/", (req, res) => res.send("✅ Mafia Game API with Advanced Crimes is running!"));

app.listen(4000, () => console.log("Server running on http://localhost:4000"));
