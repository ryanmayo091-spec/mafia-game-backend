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

// ✅ Init DB tables
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
      jail_until TIMESTAMP,
      last_crimes JSONB DEFAULT '{}' -- stores per-crime cooldowns
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crimes (
      id SERIAL PRIMARY KEY,
      name TEXT,
      description TEXT,
      min_reward INTEGER,
      max_reward INTEGER,
      success_rate REAL,
      cooldown_seconds INTEGER
    )
  `);

  // Insert starter crimes if none exist
  const { rows } = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO crimes (name, description, min_reward, max_reward, success_rate, cooldown_seconds)
      VALUES
      ('Pickpocket a stranger', 'Slip through the crowd and steal from someone distracted.', 5, 20, 0.8, 20),
      ('Mug a businessman', 'Corner a rich-looking man in an alley. Quick cash, but risky.', 20, 100, 0.6, 60),
      ('Rob a jewelry store', 'Smash-and-grab under pressure. Guards and alarms make it dangerous.', 100, 500, 0.4, 180),
      ('Bank heist', 'The ultimate score. If you succeed, you’re rich. If not, you’re in jail for a long time.', 500, 2000, 0.2, 300)
    `);
  }
}
initDB();

// ✅ Register
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

// ✅ Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });

  res.json({ success: true, user });
});

// ✅ Get crimes
app.get("/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(result.rows);
});

// ✅ Commit crime
app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;

  // Get user
  const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userResult.rows[0];
  const lastCrimes = user.last_crimes || {};

  // Jail check
  if (user.jail_until && new Date(user.jail_until) > new Date()) {
    return res.json({
      success: false,
      message: "🚔 You are in jail!",
      jail_until: user.jail_until,
    });
  }

  // Get crime
  const crimeResult = await pool.query(`SELECT * FROM crimes WHERE id = $1`, [crimeId]);
  if (crimeResult.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = crimeResult.rows[0];

  // Cooldown check
  const lastAttempt = lastCrimes[crimeId];
  if (lastAttempt && new Date(lastAttempt).getTime() + crime.cooldown_seconds * 1000 > Date.now()) {
    const waitTime = Math.ceil(
      (new Date(lastAttempt).getTime() + crime.cooldown_seconds * 1000 - Date.now()) / 1000
    );
    return res.json({
      success: false,
      message: `⏳ You must wait ${waitTime}s before trying '${crime.name}' again.`,
      cooldown: waitTime,
    });
  }

  // Roll success
  const success = Math.random() < crime.success_rate;
  let reward = 0;
  let jail_until = null;
  let story = "";

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    story = `✅ You pulled off '${crime.name}' and earned $${reward}!`;
    await pool.query(
      `UPDATE users 
       SET money = money + $1, total_crimes = total_crimes + 1, successful_crimes = successful_crimes + 1,
           last_crimes = jsonb_set(COALESCE(last_crimes, '{}'), $2, to_jsonb(NOW()::text))
       WHERE id = $3`,
      [reward, `{${crimeId}}`, userId]
    );
  } else {
    jail_until = new Date(Date.now() + crime.cooldown_seconds * 1000);
    story = `❌ '${crime.name}' went wrong! You were caught and jailed for ${crime.cooldown_seconds}s.`;
    await pool.query(
      `UPDATE users 
       SET total_crimes = total_crimes + 1, unsuccessful_crimes = unsuccessful_crimes + 1,
           jail_until = $1,
           last_crimes = jsonb_set(COALESCE(last_crimes, '{}'), $2, to_jsonb(NOW()::text))
       WHERE id = $3`,
      [jail_until, `{${crimeId}}`, userId]
    );
  }

  // Return updated user
  const updatedUser = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);

  res.json({
    success,
    reward,
    story,
    jail_until,
    user: updatedUser.rows[0],
  });
});

// ✅ Homepage
app.get("/", (req, res) => {
  res.send("✅ Mafia Game API is running with per-crime cooldowns + stories!");
});

app.listen(4000, () => console.log("🚀 Server running on http://localhost:4000"));
