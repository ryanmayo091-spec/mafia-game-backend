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

// === INIT TABLES ===
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'player',
    money INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0,
    rank TEXT DEFAULT 'Rookie',
    total_crimes INTEGER DEFAULT 0,
    successful_crimes INTEGER DEFAULT 0,
    unsuccessful_crimes INTEGER DEFAULT 0,
    jail_until TIMESTAMP,
    last_crimes JSONB DEFAULT '{}'::jsonb
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
    xp_reward INTEGER DEFAULT 5
  )`);

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
    custom_price INTEGER DEFAULT 0,
    stored_amount INTEGER DEFAULT 0,
    last_collected TIMESTAMP DEFAULT NOW()
  )`);

  // Insert a starter crime
  const { rows } = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO crimes (name, description, category, min_reward, max_reward, success_rate, cooldown_seconds, xp_reward)
       VALUES ('Beg on the streets','Spare change from strangers.','street',1,10,0.9,10,5)`
    );
  }

  // Insert a starter property (Bullet Factory)
  const pcount = await pool.query("SELECT COUNT(*) FROM properties");
  if (parseInt(pcount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO properties (name, description, base_price, income_rate, production_type, production_rate)
       VALUES ('Bullet Factory','Produces bullets over time that can be sold to other players.',50000,0,'bullets',50)`
    );
  }
}
initDB();

// === REGISTER ===
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

// === LOGIN ===
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
  if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });

  res.json({ success: true, user });
});

// === GET CRIMES ===
app.get("/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes`);
  res.json(result.rows);
});

// === PROPERTIES ===

// List all properties + owners
app.get("/properties", async (req, res) => {
  const result = await pool.query(`
    SELECT p.*, u.username as owner, up.custom_price, up.stored_amount
    FROM properties p
    LEFT JOIN user_properties up ON p.id = up.property_id
    LEFT JOIN users u ON up.user_id = u.id
  `);
  res.json(result.rows);
});

// Buy property
app.post("/properties/buy", async (req, res) => {
  const { userId, propertyId } = req.body;

  const property = await pool.query(`SELECT * FROM properties WHERE id=$1`, [propertyId]);
  if (!property.rows[0]) return res.status(404).json({ error: "Property not found" });

  const ownerCheck = await pool.query(`SELECT * FROM user_properties WHERE property_id=$1`, [propertyId]);
  if (ownerCheck.rows.length > 0) return res.status(400).json({ error: "Already owned" });

  const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (user.rows[0].money < property.rows[0].base_price) {
    return res.status(400).json({ error: "Not enough money" });
  }

  await pool.query(`UPDATE users SET money = money - $1 WHERE id=$2`, [property.rows[0].base_price, userId]);
  await pool.query(`INSERT INTO user_properties (property_id,user_id) VALUES ($1,$2)`, [propertyId, userId]);

  res.json({ success: true, message: `You bought ${property.rows[0].name}` });
});

// Collect production
app.post("/properties/collect", async (req, res) => {
  const { userId, propertyId } = req.body;

  const up = await pool.query(
    `SELECT * FROM user_properties WHERE user_id=$1 AND property_id=$2`,
    [userId, propertyId]
  );
  if (up.rows.length === 0) return res.status(404).json({ error: "You do not own this property" });

  const property = await pool.query(`SELECT * FROM properties WHERE id=$1`, [propertyId]);
  const lastCollected = new Date(up.rows[0].last_collected);
  const minutesPassed = Math.floor((Date.now() - lastCollected.getTime()) / 60000);
  let produced = 0;

  if (minutesPassed > 0) {
    produced = minutesPassed * property.rows[0].production_rate;
    await pool.query(
      `UPDATE user_properties SET stored_amount = stored_amount + $1, last_collected = NOW() WHERE id=$2`,
      [produced, up.rows[0].id]
    );
  }

  const updated = await pool.query(`SELECT * FROM user_properties WHERE id=$1`, [up.rows[0].id]);
  res.json({ success: true, produced, stored: updated.rows[0].stored_amount });
});

// Set price for property goods
app.post("/properties/set-price", async (req, res) => {
  const { userId, propertyId, price } = req.body;

  const up = await pool.query(`SELECT * FROM user_properties WHERE user_id=$1 AND property_id=$2`, [userId, propertyId]);
  if (up.rows.length === 0) return res.status(403).json({ error: "You do not own this property" });

  await pool.query(`UPDATE user_properties SET custom_price=$1 WHERE id=$2`, [price, up.rows[0].id]);

  res.json({ success: true, message: `Price updated to $${price}` });
});

// === ROOT ===
app.get("/", (req, res) => {
  res.send("✅ Mafia Game API is running!");
});

app.listen(4000, () => console.log("Server running on http://localhost:4000"));
