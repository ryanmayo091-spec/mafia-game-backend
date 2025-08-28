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

// Connect to Postgres
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
    bank_balance INTEGER DEFAULT 0,
    total_crimes INTEGER DEFAULT 0,
    successful_crimes INTEGER DEFAULT 0,
    unsuccessful_crimes INTEGER DEFAULT 0,
    last_crime TIMESTAMP,
    jail_until TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS crimes (
    id SERIAL PRIMARY KEY,
    name TEXT,
    min_reward INTEGER,
    max_reward INTEGER,
    success_rate REAL,
    cooldown_seconds INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS cars (
    id SERIAL PRIMARY KEY,
    name TEXT,
    price INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_cars (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    car_id INTEGER REFERENCES cars(id) ON DELETE CASCADE
  )`);

  // 🔹 Properties
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
    sale_price INTEGER
  )`);

  // Insert starter crimes
  const crimesCount = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(crimesCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO crimes (name, min_reward, max_reward, success_rate, cooldown_seconds)
      VALUES
      ('Beg on the streets', 1, 10, 0.9, 10),
      ('Pickpocket someone', 5, 20, 0.75, 20),
      ('Rob a small shop', 20, 100, 0.6, 30),
      ('Car theft', 100, 500, 0.4, 60),
      ('Bank heist', 1000, 5000, 0.2, 120)
    `);
  }

  // Insert cars
  const carsCount = await pool.query("SELECT COUNT(*) FROM cars");
  if (parseInt(carsCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO cars (name, price) VALUES
      ('Stolen Bike', 100),
      ('Used Sedan', 1000),
      ('Sports Car', 10000),
      ('Armored Truck', 50000)
    `);
  }

  // Insert properties
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

// --- Crimes ---
app.get("/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(result.rows);
});

// --- Properties ---
app.get("/properties", async (req, res) => {
  const result = await pool.query(`
    SELECT p.id, p.name, p.base_price, up.owner_id, up.custom_price, up.is_for_sale, up.sale_price
    FROM properties p
    LEFT JOIN user_properties up ON p.id = up.property_id
  `);
  res.json(result.rows);
});

// Buy property (from system or marketplace)
app.post("/properties/buy", async (req, res) => {
  const { userId, propertyId } = req.body;

  const property = await pool.query(`SELECT * FROM properties WHERE id=$1`, [propertyId]);
  if (property.rows.length === 0) return res.status(404).json({ error: "Property not found" });

  const basePrice = property.rows[0].base_price;

  // Check if already owned
  const owned = await pool.query(`SELECT * FROM user_properties WHERE property_id=$1`, [propertyId]);
  if (owned.rows.length > 0) {
    const prop = owned.rows[0];
    if (!prop.is_for_sale) return res.status(400).json({ error: "Property not for sale" });

    // Transfer ownership
    await pool.query(`UPDATE users SET money = money - $1 WHERE id=$2 AND money >= $1`, [prop.sale_price, userId]);
    await pool.query(`UPDATE users SET money = money + $1 WHERE id=$2`, [prop.sale_price, prop.owner_id]);
    await pool.query(`UPDATE user_properties SET owner_id=$1, is_for_sale=false, sale_price=NULL WHERE property_id=$2`, [userId, propertyId]);
  } else {
    // Buy from system
    await pool.query(`UPDATE users SET money = money - $1 WHERE id=$2 AND money >= $1`, [basePrice, userId]);
    await pool.query(`INSERT INTO user_properties (property_id, owner_id) VALUES ($1,$2)`, [propertyId, userId]);
  }

  res.json({ success: true });
});

// Sell property
app.post("/properties/sell", async (req, res) => {
  const { userId, propertyId, salePrice } = req.body;

  const property = await pool.query(`SELECT * FROM user_properties WHERE property_id=$1 AND owner_id=$2`, [propertyId, userId]);
  if (property.rows.length === 0) return res.status(400).json({ error: "You don’t own this property" });

  await pool.query(`UPDATE user_properties SET is_for_sale=true, sale_price=$1 WHERE property_id=$2`, [salePrice, propertyId]);
  res.json({ success: true });
});

// Set custom price (e.g. bullets, casino spins)
app.post("/properties/set-price", async (req, res) => {
  const { userId, propertyId, customPrice } = req.body;

  const property = await pool.query(`SELECT * FROM user_properties WHERE property_id=$1 AND owner_id=$2`, [propertyId, userId]);
  if (property.rows.length === 0) return res.status(400).json({ error: "You don’t own this property" });

  await pool.query(`UPDATE user_properties SET custom_price=$1 WHERE property_id=$2`, [customPrice, propertyId]);
  res.json({ success: true });
});

// --- Root ---
app.get("/", (req, res) => {
  res.send("✅ Mafia Game API running. Try /crimes or /properties");
});

app.listen(4000, () => console.log("Server running on http://localhost:4000"));

