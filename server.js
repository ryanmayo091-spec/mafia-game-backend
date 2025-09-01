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

// --- DB CONNECTION ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- INIT DB (tables + seeds) ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
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
      cooldown_seconds INTEGER,
      xp_reward INTEGER DEFAULT 5
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      name TEXT,
      description TEXT,
      base_price INTEGER,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      income_rate INTEGER,
      production_type TEXT,
      production_rate INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranks (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE,
      xp_required INTEGER
    )
  `);

  // Seed ranks
  const rc = await pool.query(`SELECT COUNT(*) FROM ranks`);
  if (parseInt(rc.rows[0].count) === 0) {
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

  // Seed crimes
  const cc = await pool.query(`SELECT COUNT(*) FROM crimes`);
  if (parseInt(cc.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO crimes (name, description, category, min_reward, max_reward, success_rate, cooldown_seconds, xp_reward) VALUES
      ('Beg on the streets','Spare change from strangers.','Easy',1,10,0.9,10,5),
      ('Pickpocket a stranger','Lift a wallet without being caught.','Easy',5,50,0.6,20,10),
      ('Rob a store','Quick cash grab.','Medium',50,200,0.5,60,25),
      ('Bank Heist','High stakes big win.','Hard',500,2000,0.3,300,100)
    `);
  }

  // Seed properties
  const pc = await pool.query(`SELECT COUNT(*) FROM properties`);
  if (parseInt(pc.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO properties (name, description, base_price, income_rate, production_type, production_rate) VALUES
      ('Bullet Factory','Produces bullets every 10 minutes.',50000,0,'bullets',100),
      ('Casino','Players gamble here. The house always wins.',200000,500,'cash',0),
      ('Nightclub','Generates steady cash from shady business.',100000,250,'cash',0)
    `);
  }
}
initDB().catch(console.error);

// --- AUTH ---
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING *`,
      [username, hashed]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (e) {
    res.status(400).json({ error: "Username taken" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const qr = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
  if (qr.rows.length === 0) return res.status(400).json({ error: "User not found" });
  const user = qr.rows[0];
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Invalid password" });
  res.json({ success: true, user });
});

// --- CRIMES ---
app.get("/crimes", async (_req, res) => {
  const r = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(r.rows);
});

app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;
  if (!userId || !crimeId) return res.status(400).json({ error: "Missing fields" });

  // Load user + crime
  const ur = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (ur.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = ur.rows[0];

  const cr = await pool.query(`SELECT * FROM crimes WHERE id=$1`, [crimeId]);
  if (cr.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = cr.rows[0];

  // Jail check
  if (user.jail_until && new Date(user.jail_until) > new Date()) {
    return res.json({ success: false, message: "You are in jail.", jail_until: user.jail_until });
  }

  // Per-crime cooldown check
  const lastCrimes = user.last_crimes || {};
  const last = lastCrimes[crimeId];
  const nowMs = Date.now();
  if (last && new Date(last).getTime() + crime.cooldown_seconds * 1000 > nowMs) {
    const wait = Math.ceil((new Date(last).getTime() + crime.cooldown_seconds * 1000 - nowMs) / 1000);
    return res.json({ success: false, message: `Cooldown: wait ${wait}s` });
  }

  // Roll
  const success = Math.random() < crime.success_rate;
  let reward = 0;
  let jail_until = null;

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    await pool.query(
      `
      UPDATE users
      SET money = money + $1,
          xp = xp + $2,
          total_crimes = total_crimes + 1,
          successful_crimes = successful_crimes + 1,
          last_crimes = jsonb_set(coalesce(last_crimes,'{}'::jsonb), $3, to_jsonb(NOW()))
      WHERE id = $4
      `,
      [reward, crime.xp_reward, `{${crimeId}}`, userId]
    );
  } else {
    jail_until = new Date(nowMs + crime.cooldown_seconds * 1000);
    await pool.query(
      `
      UPDATE users
      SET total_crimes = total_crimes + 1,
          unsuccessful_crimes = unsuccessful_crimes + 1,
          jail_until = $1,
          last_crimes = jsonb_set(coalesce(last_crimes,'{}'::jsonb), $2, to_jsonb(NOW()))
      WHERE id = $3
      `,
      [jail_until, `{${crimeId}}`, userId]
    );
  }

  const updated = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json({
    success,
    reward,
    jail_until,
    message: success ? `Success! You earned $${reward}` : "You failed and got jailed.",
    user: updated.rows[0],
  });
});

// --- BANK ---
app.post("/bank/deposit", async (req, res) => {
  const { userId, amount } = req.body;
  const amt = parseInt(amount, 10);
  if (!userId || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "Invalid input" });

  const u = await pool.query(`SELECT money FROM users WHERE id=$1`, [userId]);
  if (u.rows.length === 0) return res.status(404).json({ error: "User not found" });
  if (u.rows[0].money < amt) return res.status(400).json({ error: "Not enough cash" });

  const r = await pool.query(
    `UPDATE users SET money = money - $1, bank_balance = bank_balance + $1 WHERE id=$2 RETURNING *`,
    [amt, userId]
  );
  res.json({ success: true, message: `Deposited $${amt}`, user: r.rows[0] });
});

app.post("/bank/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  const amt = parseInt(amount, 10);
  if (!userId || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "Invalid input" });

  const u = await pool.query(`SELECT bank_balance FROM users WHERE id=$1`, [userId]);
  if (u.rows.length === 0) return res.status(404).json({ error: "User not found" });
  if (u.rows[0].bank_balance < amt) return res.status(400).json({ error: "Not enough in bank" });

  const r = await pool.query(
    `UPDATE users SET money = money + $1, bank_balance = bank_balance - $1 WHERE id=$2 RETURNING *`,
    [amt, userId]
  );
  res.json({ success: true, message: `Withdrew $${amt}`, user: r.rows[0] });
});

// --- PROPERTIES ---
app.get("/properties", async (_req, res) => {
  const r = await pool.query(`SELECT * FROM properties ORDER BY id ASC`);
  res.json(r.rows);
});

app.post("/buy-property", async (req, res) => {
  const { userId, propertyId } = req.body;
  if (!userId || !propertyId) return res.status(400).json({ error: "Missing fields" });

  const pr = await pool.query(`SELECT * FROM properties WHERE id=$1`, [propertyId]);
  if (pr.rows.length === 0) return res.status(404).json({ error: "Property not found" });
  const prop = pr.rows[0];

  if (prop.owner_id) return res.status(400).json({ error: "Property already owned" });

  const ur = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (ur.rows.length === 0) return res.status(404).json({ error: "User not found" });
  if (ur.rows[0].money < prop.base_price) return res.status(400).json({ error: "Not enough money" });

  await pool.query(`UPDATE users SET money = money - $1 WHERE id=$2`, [prop.base_price, userId]);
  await pool.query(`UPDATE properties SET owner_id = $1 WHERE id=$2`, [userId, propertyId]);

  const updated = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  res.json({ success: true, message: `You bought ${prop.name}`, user: updated.rows[0] });
});

// --- ADMIN ---
app.get("/admin/get-users", async (_req, res) => {
  const r = await pool.query(`SELECT id, username, money, bank_balance, xp, rank, role FROM users ORDER BY id ASC`);
  res.json(r.rows);
});

app.post("/admin/update-user", async (req, res) => {
  const { userId, money, bank_balance, xp, rank, role } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const r = await pool.query(
    `UPDATE users SET money=$1, bank_balance=$2, xp=$3, rank=$4, role=$5 WHERE id=$6 RETURNING *`,
    [parseInt(money ?? 0, 10), parseInt(bank_balance ?? 0, 10), parseInt(xp ?? 0, 10), rank || 'Rookie', role || 'player', userId]
  );
  res.json({ success: true, message: "User updated", user: r.rows[0] });
});

app.post("/admin/jail-user", async (req, res) => {
  const { userId, seconds } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const until = seconds && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
  const r = await pool.query(`UPDATE users SET jail_until=$1 WHERE id=$2 RETURNING *`, [until, userId]);
  res.json({ success: true, message: until ? `User jailed for ${seconds}s` : "User unjailed", user: r.rows[0] });
});

app.post("/admin/update-crime", async (req, res) => {
  const { crimeId, min_reward, max_reward, success_rate, cooldown_seconds } = req.body;
  if (!crimeId) return res.status(400).json({ error: "Missing crimeId" });

  await pool.query(
    `UPDATE crimes
     SET min_reward=$1, max_reward=$2, success_rate=$3, cooldown_seconds=$4
     WHERE id=$5`,
    [
      parseInt(min_reward ?? 0, 10),
      parseInt(max_reward ?? 0, 10),
      parseFloat(success_rate ?? 0.5),
      parseInt(cooldown_seconds ?? 10, 10),
      crimeId,
    ]
  );
  const r = await pool.query(`SELECT * FROM crimes WHERE id=$1`, [crimeId]);
  res.json({ success: true, message: "Crime updated", crime: r.rows[0] });
});

// --- ROOT ---
app.get("/", (_req, res) => {
  res.send("✅ Mafia Game API running");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
