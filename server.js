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

// === INIT DATABASE ===
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    money INTEGER DEFAULT 0,
    bank_balance INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0,
    rank TEXT DEFAULT 'Rookie',
    role TEXT DEFAULT 'player',
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
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    income_rate INTEGER,
    production_type TEXT,
    production_rate INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS ranks (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE,
    xp_required INTEGER
  )`);

  // Seed ranks if empty
  const rankCount = await pool.query("SELECT COUNT(*) FROM ranks");
  if (parseInt(rankCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO ranks (name, xp_required) VALUES
      ('Rookie', 0),
      ('Thug', 100),
      ('Enforcer', 300),
      ('Capo', 600),
      ('Underboss', 1000),
      ('Boss', 2000)
    `);
  }

  // Seed starter crimes
  const crimeCount = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(crimeCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO crimes (name, description, category, min_reward, max_reward, success_rate, cooldown_seconds, xp_reward)
      VALUES
      ('Beg on the streets','Spare change from strangers.','Easy',1,10,0.9,10,5),
      ('Pickpocket a stranger','Lift a wallet without being caught.','Easy',5,50,0.6,20,10),
      ('Rob a store','Quick cash grab.','Medium',50,200,0.5,60,25),
      ('Bank Heist','High stakes big win.','Hard',500,2000,0.3,300,100)
    `);
  }

  // Seed properties
  const propCount = await pool.query("SELECT COUNT(*) FROM properties");
  if (parseInt(propCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO properties (name, description, base_price, income_rate, production_type, production_rate)
      VALUES
      ('Bullet Factory','Produces bullets every 10 minutes.',50000,0,'bullets',100),
      ('Casino','Players gamble here. The house always wins.',200000,500,'cash',0),
      ('Nightclub','Generates steady cash from shady business.',100000,250,'cash',0)
    `);
  }
}
initDB();

// === AUTH ===
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

// === ADMIN ROUTES ===
app.get("/admin/get-users", async (req, res) => {
  const users = await pool.query(
    `SELECT id, username, money, bank_balance, xp, rank, role FROM users`
  );
  res.json(users.rows);
});

app.post("/admin/update-user", async (req, res) => {
  const { userId, money, bank_balance, xp, rank, role } = req.body;
  await pool.query(
    `UPDATE users SET money=$1, bank_balance=$2, xp=$3, rank=$4, role=$5 WHERE id=$6`,
    [money, bank_balance, xp, rank, role, userId]
  );
  res.json({ success: true, message: "User updated" });
});

app.post("/admin/jail-user", async (req, res) => {
  const { userId, jailSeconds } = req.body;
  const until = jailSeconds ? new Date(Date.now() + jailSeconds * 1000) : null;
  await pool.query(`UPDATE users SET jail_until=$1 WHERE id=$2`, [
    until,
    userId,
  ]);
  res.json({ success: true, message: "User jail updated" });
});

app.post("/admin/set-property-owner", async (req, res) => {
  const { propertyId, ownerId } = req.body;
  await pool.query(`UPDATE properties SET owner_id=$1 WHERE id=$2`, [
    ownerId,
    propertyId,
  ]);
  res.json({ success: true, message: "Property ownership updated" });
});

app.post("/admin/update-crime", async (req, res) => {
  const { crimeId, min_reward, max_reward, success_rate, cooldown_seconds } =
    req.body;
  await pool.query(
    `UPDATE crimes SET min_reward=$1, max_reward=$2, success_rate=$3, cooldown_seconds=$4 WHERE id=$5`,
    [min_reward, max_reward, success_rate, cooldown_seconds, crimeId]
  );
  res.json({ success: true, message: "Crime updated" });
});

// === TEST ROOT ===
app.get("/", (req, res) => {
  res.send("✅ Mafia Game API running with Admin routes");
});

app.listen(4000, () =>
  console.log("Server running on http://localhost:4000")
);

