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

  await pool.query(`CREATE TABLE IF NOT EXISTS properties (
    id SERIAL PRIMARY KEY,
    name TEXT,
    price INTEGER,
    income_per_hour INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_properties (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE
  )`);

  // Insert starter crimes if none exist
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
      INSERT INTO properties (name, price, income_per_hour) VALUES
      ('Bullet Factory', 10000, 500),
      ('Casino', 50000, 3000),
      ('Nightclub', 20000, 1200)
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

app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;
  const userResult = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userResult.rows[0];

  const crimeResult = await pool.query(`SELECT * FROM crimes WHERE id=$1`, [crimeId]);
  if (crimeResult.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = crimeResult.rows[0];

  const success = Math.random() < crime.success_rate;
  let reward = 0;
  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    await pool.query(
      `UPDATE users SET money = money + $1, total_crimes = total_crimes+1, successful_crimes=successful_crimes+1 WHERE id=$2`,
      [reward, userId]
    );
  } else {
    const jail_until = new Date(Date.now() + crime.cooldown_seconds * 1000);
    await pool.query(
      `UPDATE users SET total_crimes = total_crimes+1, unsuccessful_crimes=unsuccessful_crimes+1, jail_until=$1 WHERE id=$2`,
      [jail_until, userId]
    );
  }

  const updatedUser = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json({ success, reward, user: updatedUser.rows[0] });
});

// --- Bank ---
app.post("/bank/deposit", async (req, res) => {
  const { userId, amount } = req.body;
  await pool.query(`UPDATE users SET money=money-$1, bank_balance=bank_balance+$1 WHERE id=$2 AND money >= $1`, [amount, userId]);
  const updatedUser = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json(updatedUser.rows[0]);
});

app.post("/bank/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  await pool.query(`UPDATE users SET bank_balance=bank_balance-$1, money=money+$1 WHERE id=$2 AND bank_balance >= $1`, [amount, userId]);
  const updatedUser = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json(updatedUser.rows[0]);
});

// --- Garage ---
app.get("/cars", async (req, res) => {
  const result = await pool.query(`SELECT * FROM cars ORDER BY price ASC`);
  res.json(result.rows);
});

app.post("/garage/buy", async (req, res) => {
  const { userId, carId } = req.body;
  const car = await pool.query(`SELECT * FROM cars WHERE id=$1`, [carId]);
  if (car.rows.length === 0) return res.status(404).json({ error: "Car not found" });
  const price = car.rows[0].price;

  await pool.query(`UPDATE users SET money=money-$1 WHERE id=$2 AND money >= $1`, [price, userId]);
  await pool.query(`INSERT INTO user_cars (user_id, car_id) VALUES ($1,$2)`, [userId, carId]);
  const updatedCars = await pool.query(
    `SELECT c.* FROM user_cars uc JOIN cars c ON uc.car_id=c.id WHERE uc.user_id=$1`,
    [userId]
  );
  res.json(updatedCars.rows);
});

// --- Properties ---
app.get("/properties", async (req, res) => {
  const result = await pool.query(`SELECT * FROM properties ORDER BY price ASC`);
  res.json(result.rows);
});

app.post("/properties/buy", async (req, res) => {
  const { userId, propertyId } = req.body;
  const property = await pool.query(`SELECT * FROM properties WHERE id=$1`, [propertyId]);
  if (property.rows.length === 0) return res.status(404).json({ error: "Property not found" });
  const price = property.rows[0].price;

  await pool.query(`UPDATE users SET money=money-$1 WHERE id=$2 AND money >= $1`, [price, userId]);
  await pool.query(`INSERT INTO user_properties (user_id, property_id) VALUES ($1,$2)`, [userId, propertyId]);
  const updatedProps = await pool.query(
    `SELECT p.* FROM user_properties up JOIN properties p ON up.property_id=p.id WHERE up.user_id=$1`,
    [userId]
  );
  res.json(updatedProps.rows);
});

// Root
app.get("/", (req, res) => {
  res.send("✅ Mafia Game API running. Try /crimes, /cars, /properties");
});

app.listen(4000, () => console.log("Server running on http://localhost:4000"));
