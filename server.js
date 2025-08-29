import express from "express";
import pkg from "pg";
import bcrypt from "bcrypt";
import bodyParser from "body-parser";
import cors from "cors";

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(bodyParser.json());

// Connect to DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// === Rank System Config ===
const RANKS = [
  { name: "Rookie", xp: 0 },
  { name: "Thug", xp: 100 },
  { name: "Hustler", xp: 300 },
  { name: "Gangster", xp: 700 },
  { name: "Capo", xp: 1500 },
  { name: "Underboss", xp: 3000 },
  { name: "Boss", xp: 6000 },
  { name: "Godfather", xp: 12000 }
];

function getRank(xp) {
  let current = RANKS[0].name;
  for (let rank of RANKS) {
    if (xp >= rank.xp) current = rank.name;
  }
  return current;
}

// === Init DB Tables ===
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      money INTEGER DEFAULT 0,
      points INTEGER DEFAULT 0,
      total_crimes INTEGER DEFAULT 0,
      successful_crimes INTEGER DEFAULT 0,
      unsuccessful_crimes INTEGER DEFAULT 0,
      last_crimes JSONB DEFAULT '{}'::jsonb,
      xp INTEGER DEFAULT 0,
      rank TEXT DEFAULT 'Rookie'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crimes (
      id SERIAL PRIMARY KEY,
      name TEXT,
      description TEXT,
      category TEXT,
      min_reward INTEGER,
      max_reward INTEGER,
      success_rate REAL,
      cooldown_seconds INTEGER
    )
  `);
}
initDB();

// === Register ===
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

// === Login ===
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });

  res.json({ success: true, user });
});

// === Get Crimes ===
app.get("/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(result.rows);
});

// === Commit Crime ===
app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;

  const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userResult.rows[0];

  const crimeResult = await pool.query(`SELECT * FROM crimes WHERE id = $1`, [crimeId]);
  if (crimeResult.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = crimeResult.rows[0];

  // Check cooldown
  const lastCrimes = user.last_crimes || {};
  const lastCrimeTime = lastCrimes[crimeId] ? new Date(lastCrimes[crimeId]).getTime() : 0;
  const now = Date.now();
  if (lastCrimeTime + crime.cooldown_seconds * 1000 > now) {
    const wait = Math.ceil((lastCrimeTime + crime.cooldown_seconds * 1000 - now) / 1000);
    return res.json({ success: false, message: `⏳ Wait ${wait}s`, cooldown: wait });
  }

  const success = Math.random() < crime.success_rate;
  let reward = 0;
  let xpGain = Math.floor(crime.max_reward / 10);

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    await pool.query(
      `UPDATE users 
       SET money = money + $1, xp = xp + $2, total_crimes = total_crimes + 1, successful_crimes = successful_crimes + 1,
           last_crimes = COALESCE(last_crimes, '{}'::jsonb) || jsonb_build_object($3, NOW())
       WHERE id = $4`,
      [reward, xpGain, crimeId, userId]
    );
  } else {
    xpGain = Math.floor(xpGain / 4);
    await pool.query(
      `UPDATE users 
       SET xp = xp + $1, total_crimes = total_crimes + 1, unsuccessful_crimes = unsuccessful_crimes + 1,
           last_crimes = COALESCE(last_crimes, '{}'::jsonb) || jsonb_build_object($2, NOW())
       WHERE id = $3`,
      [xpGain, crimeId, userId]
    );
  }

  // Update rank
  const updatedUserResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const updatedUser = updatedUserResult.rows[0];
  const newRank = getRank(updatedUser.xp);

  if (newRank !== updatedUser.rank) {
    await pool.query(`UPDATE users SET rank = $1 WHERE id = $2`, [newRank, userId]);
    updatedUser.rank = newRank;
  }

  res.json({
    success,
    reward,
    xpGain,
    newRank: updatedUser.rank,
    message: success ? `✅ You earned $${reward} and ${xpGain} XP` : `❌ You failed but gained ${xpGain} XP`,
    user: updatedUser,
  });
});

// === Root ===
app.get("/", (req, res) => res.send("✅ Mafia Game API Running"));

app.listen(4000, () => console.log("Server running on http://localhost:4000"));
