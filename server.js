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

// --- DB Init ---
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    money INTEGER DEFAULT 0,
    bank_balance INTEGER DEFAULT 0,
    bullets INTEGER DEFAULT 0,
    role TEXT DEFAULT 'player',
    total_crimes INTEGER DEFAULT 0,
    successful_crimes INTEGER DEFAULT 0,
    unsuccessful_crimes INTEGER DEFAULT 0,
    last_crime TIMESTAMP,
    jail_until TIMESTAMP,
    gang_id INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS crimes (
    id SERIAL PRIMARY KEY,
    name TEXT,
    min_reward INTEGER,
    max_reward INTEGER,
    success_rate REAL,
    cooldown_seconds INTEGER
  )`);

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
    bullets INTEGER DEFAULT 0,
    last_production TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS cars (
    id SERIAL PRIMARY KEY,
    model TEXT,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    price INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS blackmarket_items (
    id SERIAL PRIMARY KEY,
    name TEXT,
    price INTEGER,
    seller_id INTEGER REFERENCES users(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS gangs (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE,
    boss_id INTEGER REFERENCES users(id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS gang_wars (
    id SERIAL PRIMARY KEY,
    gang_a INTEGER REFERENCES gangs(id),
    gang_b INTEGER REFERENCES gangs(id),
    winner INTEGER,
    loser INTEGER,
    bullets_used INTEGER,
    war_time TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS casino_config (
    id INT PRIMARY KEY,
    slot_odds REAL,
    blackjack_odds REAL
  )`);

  // Seed defaults
  const crimesCount = await pool.query("SELECT COUNT(*) FROM crimes");
  if (parseInt(crimesCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO crimes (name, min_reward, max_reward, success_rate, cooldown_seconds)
      VALUES
      ('Beg on the streets', 1, 10, 0.9, 10),
      ('Pickpocket', 5, 20, 0.75, 20),
      ('Rob a shop', 20, 100, 0.6, 30),
      ('Car theft', 100, 500, 0.4, 60),
      ('Bank heist', 1000, 5000, 0.2, 120)
    `);
  }

  const propsCount = await pool.query("SELECT COUNT(*) FROM properties");
  if (parseInt(propsCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO properties (name, base_price) VALUES
      ('Bullet Factory', 10000),
      ('Casino', 50000),
      ('Nightclub', 20000)
    `);
  }

  const casinoConf = await pool.query("SELECT COUNT(*) FROM casino_config");
  if (parseInt(casinoConf.rows[0].count) === 0) {
    await pool.query("INSERT INTO casino_config (id, slot_odds, blackjack_odds) VALUES (1,0.3,0.45)");
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
  } catch {
    res.status(400).json({ error: "Username taken" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
  if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });

  res.json({ success: true, user });
});

// --- Crimes ---
app.get("/crimes", async (_, res) => {
  const result = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(result.rows);
});

// --- Bank ---
app.post("/bank/deposit", async (req, res) => {
  const { userId, amount } = req.body;
  if (amount <= 0) return res.status(400).json({ error: "Invalid amount" });

  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.money < amount) return res.status(400).json({ error: "Not enough cash" });

  await pool.query(`UPDATE users SET money=money-$1, bank_balance=bank_balance+$1 WHERE id=$2`, [amount, userId]);
  const updated = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json({ success: true, user: updated.rows[0], message: `Deposited $${amount}` });
});

app.post("/bank/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  if (amount <= 0) return res.status(400).json({ error: "Invalid amount" });

  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.bank_balance < amount) return res.status(400).json({ error: "Not enough bank balance" });

  await pool.query(`UPDATE users SET money=money+$1, bank_balance=bank_balance-$1 WHERE id=$2`, [amount, userId]);
  const updated = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json({ success: true, user: updated.rows[0], message: `Withdrew $${amount}` });
});

// --- Garage ---
app.get("/garage/:userId", async (req, res) => {
  const { userId } = req.params;
  const cars = await pool.query(`SELECT * FROM cars WHERE owner_id=$1`, [userId]);
  res.json(cars.rows);
});

app.post("/garage/buy", async (req, res) => {
  const { userId, model } = req.body;
  const prices = { Sedan: 1000, Sports: 5000, Armored: 20000 };
  const price = prices[model] || 1000;

  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.money < price) return res.status(400).json({ error: "Not enough money" });

  await pool.query(`UPDATE users SET money=money-$1 WHERE id=$2`, [price, userId]);
  await pool.query(`INSERT INTO cars (model, owner_id, price) VALUES ($1,$2,$3)`, [model, userId, price]);
  res.json({ success: true, message: `Bought ${model} for $${price}` });
});

app.post("/garage/sell", async (req, res) => {
  const { userId, carId } = req.body;
  const carRes = await pool.query(`SELECT * FROM cars WHERE id=$1 AND owner_id=$2`, [carId, userId]);
  if (carRes.rows.length === 0) return res.status(404).json({ error: "Car not found" });
  const car = carRes.rows[0];

  await pool.query(`DELETE FROM cars WHERE id=$1`, [carId]);
  await pool.query(`UPDATE users SET money=money+$1 WHERE id=$2`, [Math.floor(car.price / 2), userId]);
  res.json({ success: true, message: `Sold ${car.model} for $${Math.floor(car.price / 2)}` });
});

// --- Casino ---
app.post("/casino/slots", async (req, res) => {
  const { userId } = req.body;
  const conf = await pool.query("SELECT * FROM casino_config WHERE id=1");
  const odds = conf.rows[0]?.slot_odds || 0.3;

  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.money < 100) return res.json({ success: false, message: "Need $100 to play" });

  await pool.query(`UPDATE users SET money=money-100 WHERE id=$1`, [userId]);
  if (Math.random() < odds) {
    await pool.query(`UPDATE users SET money=money+500 WHERE id=$1`, [userId]);
    return res.json({ success: true, message: "🎰 JACKPOT! You won $500" });
  }
  res.json({ success: false, message: "🎰 Lost this spin." });
});

app.post("/casino/blackjack", async (req, res) => {
  const { userId } = req.body;
  const conf = await pool.query("SELECT * FROM casino_config WHERE id=1");
  const odds = conf.rows[0]?.blackjack_odds || 0.45;

  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.money < 200) return res.json({ success: false, message: "Need $200 to play" });

  await pool.query(`UPDATE users SET money=money-200 WHERE id=$1`, [userId]);
  if (Math.random() < odds) {
    await pool.query(`UPDATE users SET money=money+400 WHERE id=$1`, [userId]);
    return res.json({ success: true, message: "🃏 You won Blackjack! $400 earned." });
  }
  res.json({ success: false, message: "🃏 Lost the hand." });
});

// --- Black Market ---
app.get("/blackmarket", async (_, res) => {
  const items = await pool.query(`SELECT * FROM blackmarket_items`);
  res.json(items.rows);
});

app.post("/blackmarket/buy", async (req, res) => {
  const { userId, itemId } = req.body;
  const itemRes = await pool.query(`SELECT * FROM blackmarket_items WHERE id=$1`, [itemId]);
  if (itemRes.rows.length === 0) return res.status(404).json({ error: "Item not found" });
  const item = itemRes.rows[0];

  const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.money < item.price) return res.status(400).json({ error: "Not enough money" });

  await pool.query(`UPDATE users SET money=money-$1 WHERE id=$2`, [item.price, userId]);
  await pool.query(`UPDATE users SET money=money+$1 WHERE id=$2`, [item.price, item.seller_id]);
  await pool.query(`DELETE FROM blackmarket_items WHERE id=$1`, [itemId]);
  res.json({ success: true, message: `Bought ${item.name} for $${item.price}` });
});

// --- Properties ---
app.get("/properties", async (_, res) => {
  const result = await pool.query(`
    SELECT p.id, p.name, up.owner_id, up.custom_price, up.bullets
    FROM properties p
    LEFT JOIN user_properties up ON p.id = up.property_id
  `);
  res.json(result.rows);
});

app.post("/properties/set-price", async (req, res) => {
  const { userId, propertyId, customPrice } = req.body;
  const result = await pool.query(`SELECT * FROM user_properties WHERE property_id=$1 AND owner_id=$2`, [propertyId, userId]);
  if (result.rows.length === 0) return res.status(400).json({ error: "You don’t own this property" });

  await pool.query(`UPDATE user_properties SET custom_price=$1 WHERE property_id=$2 AND owner_id=$3`, [customPrice, propertyId, userId]);
  res.json({ success: true });
});

// --- Gangs ---
app.get("/gang/wars", async (_, res) => {
  const wars = await pool.query(`
    SELECT gw.id, gw.war_time, g1.name AS gang_a, g2.name AS gang_b,
           gw.winner, gw.loser, gw.bullets_used
    FROM gang_wars gw
    LEFT JOIN gangs g1 ON gw.gang_a=g1.id
    LEFT JOIN gangs g2 ON gw.gang_b=g2.id
    ORDER BY gw.war_time DESC
    LIMIT 20
  `);
  res.json(wars.rows);
});

// --- Admin ---
async function isAdmin(userId) {
  const result = await pool.query(`SELECT role FROM users WHERE id=$1`, [userId]);
  if (result.rows.length === 0) return false;
  const role = result.rows[0].role;
  return role === "admin" || role === "mod";
}

app.get("/admin/users/:adminId", async (req, res) => {
  const { adminId } = req.params;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });

  const users = await pool.query(`SELECT id, username, money, bank_balance, bullets, role FROM users ORDER BY id ASC`);
  res.json(users.rows);
});

app.post("/admin/update-user", async (req, res) => {
  const { adminId, targetId, money, bullets, role } = req.body;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });

  await pool.query(
    `UPDATE users SET money=$1, bullets=$2, role=$3 WHERE id=$4`,
    [money, bullets, role, targetId]
  );
  res.json({ success: true, message: "User updated" });
});

app.post("/admin/delete-user", async (req, res) => {
  const { adminId, targetId } = req.body;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });

  await pool.query(`DELETE FROM users WHERE id=$1`, [targetId]);
  res.json({ success: true, message: "User deleted" });
});

app.post("/admin/ban-user", async (req, res) => {
  const { adminId, targetId } = req.body;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });

  await pool.query(`UPDATE users SET role='banned' WHERE id=$1`, [targetId]);
  res.json({ success: true, message: "User banned" });
});

app.post("/admin/update-casino", async (req, res) => {
  const { adminId, slot_odds, blackjack_odds } = req.body;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });

  await pool.query(`INSERT INTO casino_config (id, slot_odds, blackjack_odds)
                    VALUES (1,$1,$2)
                    ON CONFLICT (id) DO UPDATE SET slot_odds=$1, blackjack_odds=$2`,
    [slot_odds, blackjack_odds]);
  res.json({ success: true, message: "Casino odds updated" });
});

app.get("/admin/stats/:adminId", async (req, res) => {
  const { adminId } = req.params;
  if (!(await isAdmin(adminId))) return res.status(403).json({ error: "Not authorized" });

  const richest = await pool.query(`SELECT username, money FROM users ORDER BY money DESC LIMIT 1`);
  const bullets = await pool.query(`SELECT username, bullets FROM users ORDER BY bullets DESC LIMIT 1`);
  const gangs = await pool.query(`SELECT name FROM gangs LIMIT 5`);
  const users = await pool.query(`SELECT COUNT(*) FROM users`);

  res.json({
    total_users: users.rows[0].count,
    richest: richest.rows[0],
    most_bullets: bullets.rows[0],
    gangs: gangs.rows,
  });
});

// Root
app.get("/", (_, res) => res.send("✅ Mafia Game API running!"));

app.listen(4000, () => console.log("Server running http://localhost:4000"));
