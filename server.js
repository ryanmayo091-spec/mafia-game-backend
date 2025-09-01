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

// === INIT DATABASE ===
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    money INTEGER DEFAULT 0,
    bank INTEGER DEFAULT 0,
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

  await pool.query(`CREATE TABLE IF NOT EXISTS user_crime_cooldowns (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    crime_id INTEGER REFERENCES crimes(id) ON DELETE CASCADE,
    last_attempt TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_cars (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    car_name TEXT,
    car_value INTEGER
  )`);

  // Insert a starter crime if none exist
  const { rows } = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO crimes (name, description, category, min_reward, max_reward, success_rate, cooldown_seconds, xp_reward)
       VALUES 
       ('Beg on the streets','Spare change from strangers.','Easy',1,10,0.9,10,5),
       ('Pickpocket a stranger','Lift a wallet without being caught.','Medium',5,50,0.6,20,10),
       ('Rob a store','Small store robbery attempt.','Hard',20,200,0.4,60,20)`
    );
  }

  // Ranks table
  await pool.query(`CREATE TABLE IF NOT EXISTS ranks (
    id SERIAL PRIMARY KEY,
    name TEXT,
    xp_required INTEGER
  )`);

  const rcount = await pool.query("SELECT COUNT(*) FROM ranks");
  if (parseInt(rcount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO ranks (name, xp_required) VALUES
      ('Rookie', 0),
      ('Thug', 100),
      ('Enforcer', 300),
      ('Capo', 700),
      ('Underboss', 1500),
      ('Boss', 3000)`
    );
  }
}

initDB();

// === AUTH ROUTES ===
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username, role`,
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

// === CRIMES ===
app.get("/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(result.rows);
});

app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;

  const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userResult.rows[0];

  if (user.jail_until && new Date(user.jail_until) > new Date()) {
    return res.json({ success: false, message: "You are in jail!", jail_until: user.jail_until });
  }

  const crimeResult = await pool.query(`SELECT * FROM crimes WHERE id = $1`, [crimeId]);
  if (crimeResult.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = crimeResult.rows[0];

  const cooldown = await pool.query(
    `SELECT * FROM user_crime_cooldowns WHERE user_id = $1 AND crime_id = $2`,
    [userId, crimeId]
  );

  if (cooldown.rows.length > 0) {
    const lastAttempt = new Date(cooldown.rows[0].last_attempt);
    if (lastAttempt.getTime() + crime.cooldown_seconds * 1000 > Date.now()) {
      const waitTime = Math.ceil(
        (lastAttempt.getTime() + crime.cooldown_seconds * 1000 - Date.now()) / 1000
      );
      return res.json({ success: false, message: `Wait ${waitTime}s before retrying.` });
    }
  }

  const success = Math.random() < crime.success_rate;
  let reward = 0;
  let jail_until = null;

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    await pool.query(
      `UPDATE users 
       SET money = money + $1, xp = xp + $2, total_crimes = total_crimes + 1, successful_crimes = successful_crimes + 1
       WHERE id = $3`,
      [reward, crime.xp_reward, userId]
    );
  } else {
    jail_until = new Date(Date.now() + crime.cooldown_seconds * 1000);
    await pool.query(
      `UPDATE users 
       SET total_crimes = total_crimes + 1, unsuccessful_crimes = unsuccessful_crimes + 1, jail_until = $1
       WHERE id = $2`,
      [jail_until, userId]
    );
  }

  await pool.query(
    `INSERT INTO user_crime_cooldowns (user_id, crime_id, last_attempt)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, crime_id) DO UPDATE SET last_attempt = NOW()`,
    [userId, crimeId]
  );

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

// === BANK ===
app.post("/bank/deposit", async (req, res) => {
  const { userId, amount } = req.body;
  await pool.query(
    `UPDATE users SET money = money - $1, bank = bank + $1 WHERE id = $2 AND money >= $1`,
    [amount, userId]
  );
  res.json({ success: true, message: "Deposit complete" });
});

app.post("/bank/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  await pool.query(
    `UPDATE users SET money = money + $1, bank = bank - $1 WHERE id = $2 AND bank >= $1`,
    [amount, userId]
  );
  res.json({ success: true, message: "Withdraw complete" });
});

// === ADMIN ROUTES ===
app.get("/admin/users", async (req, res) => {
  const result = await pool.query(`SELECT id, username, role, money FROM users ORDER BY id ASC`);
  res.json(result.rows);
});

app.get("/admin/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(result.rows);
});

app.post("/admin/give-money", async (req, res) => {
  const { userId, targetId, amount } = req.body;
  const admin = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (!admin.rows[0] || !["admin", "mod"].includes(admin.rows[0].role)) {
    return res.status(403).json({ success: false, message: "Not authorized" });
  }
  await pool.query(`UPDATE users SET money = money + $1 WHERE id = $2`, [amount, targetId]);
  res.json({ success: true, message: `Gave $${amount} to user ${targetId}` });
});

app.post("/admin/jail-user", async (req, res) => {
  const { targetId, minutes } = req.body;
  const jailUntil = new Date(Date.now() + minutes * 60000);
  await pool.query(`UPDATE users SET jail_until = $1 WHERE id = $2`, [jailUntil, targetId]);
  res.json({ success: true, message: `User jailed for ${minutes} minutes.` });
});

app.post("/admin/release-user", async (req, res) => {
  const { targetId } = req.body;
  await pool.query(`UPDATE users SET jail_until = NULL WHERE id = $1`, [targetId]);
  res.json({ success: true, message: `User released.` });
});

app.post("/admin/set-role", async (req, res) => {
  const { userId, targetId, role } = req.body;
  const admin = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (!admin.rows[0] || admin.rows[0].role !== "admin") {
    return res.status(403).json({ success: false, message: "Only admins can change roles." });
  }
  await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [role, targetId]);
  res.json({ success: true, message: `User role updated to ${role}` });
});

// === ROOT ===
app.get("/", (req, res) => {
  res.send("✅ Mafia Game API running. Try /crimes");
});

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


app.listen(4000, () => console.log("Server running on http://localhost:4000"));



