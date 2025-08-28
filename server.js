import express from "express";
import pkg from "pg";
import bcrypt from "bcrypt";
import bodyParser from "body-parser";
import cors from "cors";

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(bodyParser.json());

// Connect to Postgres using environment variable from Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Initialize DB tables
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    money INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    total_crimes INTEGER DEFAULT 0,
    successful_crimes INTEGER DEFAULT 0,
    unsuccessful_crimes INTEGER DEFAULT 0
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS crimes (
    id SERIAL PRIMARY KEY,
    name TEXT,
    min_reward INTEGER,
    max_reward INTEGER,
    success_rate REAL,
    cooldown_seconds INTEGER
  )`);

  // Insert starter crime if none exist
  const { rows } = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO crimes (name, min_reward, max_reward, success_rate, cooldown_seconds)
       VALUES ($1, $2, $3, $4, $5)`,
      ["Beg on the streets", 1, 10, 0.9, 10]
    );
  }
}

initDB();

// Register
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`,
      [username, hashed]
    );
    res.json({ success: true, userId: result.rows[0].id });
  } catch (err) {
    res.status(400).json({ error: "Username taken" });
  }
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });

  res.json({ success: true, user });
});

// Commit crime with cooldown
app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;

  // Get user
  const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userResult.rows[0];

  // Check jail
  if (user.jail_until && new Date(user.jail_until) > new Date()) {
    return res.json({ success: false, message: "You are in jail!", jail_until: user.jail_until });
  }

  // Get crime
  const crimeResult = await pool.query(`SELECT * FROM crimes WHERE id = $1`, [crimeId]);
  if (crimeResult.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = crimeResult.rows[0];

  // Check cooldown
  if (user.last_crime && new Date(user.last_crime).getTime() + (crime.cooldown_seconds * 1000) > Date.now()) {
    const waitTime = Math.ceil(
      (user.last_crime.getTime() + crime.cooldown_seconds * 1000 - Date.now()) / 1000
    );
    return res.json({ success: false, message: `You must wait ${waitTime}s before committing another crime.`, cooldown: waitTime });
  }

  // Roll success/fail
  const success = Math.random() < crime.success_rate;
  let reward = 0;
  let jail_until = null;

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    await pool.query(
      `UPDATE users 
       SET money = money + $1, total_crimes = total_crimes + 1, successful_crimes = successful_crimes + 1, last_crime = NOW()
       WHERE id = $2`,
      [reward, userId]
    );
  } else {
    jail_until = new Date(Date.now() + crime.cooldown_seconds * 1000);
    await pool.query(
      `UPDATE users 
       SET total_crimes = total_crimes + 1, unsuccessful_crimes = unsuccessful_crimes + 1, jail_until = $1, last_crime = NOW()
       WHERE id = $2`,
      [jail_until, userId]
    );
  }

  // Return updated user
  const updatedUser = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);

  res.json({
    success,
    reward,
    message: success
      ? `You earned $${reward}!`
      : `You failed and are jailed for ${crime.cooldown_seconds} seconds.`,
    user: updatedUser.rows[0]
  });
});



// ✅ Homepage route
app.get("/", (req, res) => {
  res.send("✅ Mafia Game API is running! Try /crimes");
});

app.listen(4000, () => console.log("Server running on http://localhost:4000"));


