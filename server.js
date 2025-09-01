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

// === Initialize DB ===
async function initDB() {
  // Users
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    money INTEGER DEFAULT 0,
    bank_balance INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    total_crimes INTEGER DEFAULT 0,
    successful_crimes INTEGER DEFAULT 0,
    unsuccessful_crimes INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0,
    rank TEXT DEFAULT 'Rookie',
    role TEXT DEFAULT 'player',
    jail_until TIMESTAMP,
    last_crimes JSONB DEFAULT '{}'::jsonb
  )`);

  // Crimes
  await pool.query(`CREATE TABLE IF NOT EXISTS crimes (
    id SERIAL PRIMARY KEY,
    name TEXT,
    description TEXT,
    category TEXT,
    min_reward INTEGER,
    max_reward INTEGER,
    success_rate REAL,
    cooldown_seconds INTEGER,
    xp_reward INTEGER DEFAULT 5
  )`);

  // Cooldowns
  await pool.query(`CREATE TABLE IF NOT EXISTS user_crime_cooldowns (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    crime_id INTEGER REFERENCES crimes(id) ON DELETE CASCADE,
    last_attempt TIMESTAMP
  )`);

  // Cars
  await pool.query(`CREATE TABLE IF NOT EXISTS user_cars (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    car_name TEXT,
    value INTEGER
  )`);

  // Properties
  await pool.query(`CREATE TABLE IF NOT EXISTS properties (
    id SERIAL PRIMARY KEY,
    name TEXT,
    description TEXT,
    base_price INTEGER,
    income_rate INTEGER,
    production_type TEXT,
    production_rate INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_properties (
    id SERIAL PRIMARY KEY,
    property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    custom_price INTEGER,
    last_collected TIMESTAMP
  )`);

  // ✅ Seed properties
  const { rows } = await pool.query("SELECT COUNT(*) FROM properties");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO properties (name, description, base_price, income_rate, production_type, production_rate)
       VALUES 
       ('Bullet Factory', 'Produces bullets over time for resale.', 50000, 1000, 'bullets', 50),
       ('Casino', 'Players gamble here. Owner earns profits from house edge.', 100000, 2000, 'cash', 0),
       ('Nightclub', 'Generates steady passive income.', 75000, 1500, 'cash', 0)`
    );
  }
}
initDB();

// === Auth ===
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

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [
    username,
  ]);
  if (result.rows.length === 0)
    return res.status(400).json({ error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });

  res.json({ success: true, user });
});

// === Crimes ===
app.get("/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes`);
  res.json(result.rows);
});

// === Properties ===
app.get("/properties", async (req, res) => {
  const result = await pool.query(`SELECT * FROM properties`);
  res.json(result.rows);
});

app.post("/properties/buy", async (req, res) => {
  const { userId, propertyId } = req.body;

  const property = (
    await pool.query(`SELECT * FROM properties WHERE id=$1`, [propertyId])
  ).rows[0];
  if (!property) return res.status(404).json({ error: "Property not found" });

  const user = (await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]))
    .rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.money < property.base_price)
    return res.json({ success: false, message: "Not enough money" });

  await pool.query(
    `UPDATE users SET money = money - $1 WHERE id=$2`,
    [property.base_price, userId]
  );
  await pool.query(
    `INSERT INTO user_properties (property_id, user_id, last_collected) VALUES ($1,$2,NOW())`,
    [propertyId, userId]
  );

  res.json({ success: true, message: `You bought ${property.name}` });
});

app.post("/properties/collect", async (req, res) => {
  const { userId, propertyId } = req.body;

  const ownership = (
    await pool.query(
      `SELECT * FROM user_properties WHERE user_id=$1 AND property_id=$2`,
      [userId, propertyId]
    )
  ).rows[0];
  if (!ownership)
    return res.status(403).json({ error: "You do not own this property" });

  const property = (
    await pool.query(`SELECT * FROM properties WHERE id=$1`, [propertyId])
  ).rows[0];

  let reward = property.income_rate;
  if (property.production_type === "bullets") {
    reward = property.production_rate;
  }

  await pool.query(`UPDATE users SET money = money + $1 WHERE id=$2`, [
    reward,
    userId,
  ]);
  await pool.query(
    `UPDATE user_properties SET last_collected=NOW() WHERE id=$1`,
    [ownership.id]
  );

  res.json({ success: true, reward, type: property.production_type });
});

// === Homepage route ===
app.get("/", (req, res) => {
  res.send("✅ Mafia Game API running with Properties seeded!");
});

app.listen(4000, () =>
  console.log("Server running on http://localhost:4000")
);
