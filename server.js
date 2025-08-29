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

// === Migration for XP + Rank ===
await pool.query(`
  ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rank TEXT DEFAULT 'Rookie';
`);

// === Get Crimes (locked by rank) ===
app.get("/crimes", async (req, res) => {
  const result = await pool.query(`SELECT * FROM crimes ORDER BY id ASC`);
  res.json(result.rows);
});

// === Commit Crime with XP + Rank ===
app.post("/commit-crime", async (req, res) => {
  const { userId, crimeId } = req.body;

  const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userResult.rows[0];

  const crimeResult = await pool.query(`SELECT * FROM crimes WHERE id = $1`, [crimeId]);
  if (crimeResult.rows.length === 0) return res.status(404).json({ error: "Crime not found" });
  const crime = crimeResult.rows[0];

  // Check per-crime cooldown
  const lastCrimes = user.last_crimes || {};
  const lastCrimeTime = lastCrimes[crimeId] ? new Date(lastCrimes[crimeId]).getTime() : 0;
  const now = Date.now();

  if (lastCrimeTime + crime.cooldown_seconds * 1000 > now) {
    const wait = Math.ceil((lastCrimeTime + crime.cooldown_seconds * 1000 - now) / 1000);
    return res.json({ success: false, message: `⏳ Wait ${wait}s before retrying this crime.`, cooldown: wait });
  }

  const success = Math.random() < crime.success_rate;
  let reward = 0;
  let xpGain = Math.floor(crime.max_reward / 10); // XP scales with crime difficulty

  if (success) {
    reward = Math.floor(Math.random() * (crime.max_reward - crime.min_reward + 1)) + crime.min_reward;
    await pool.query(
      `UPDATE users 
       SET money = money + $1, xp = xp + $2,
           total_crimes = total_crimes + 1, successful_crimes = successful_crimes + 1,
           last_crimes = COALESCE(last_crimes, '{}'::jsonb) || jsonb_build_object($3, NOW())
       WHERE id = $4`,
      [reward, xpGain, crimeId, userId]
    );
  } else {
    xpGain = Math.floor(xpGain / 4); // failing still gives a little XP
    await pool.query(
      `UPDATE users 
       SET xp = xp + $1,
           total_crimes = total_crimes + 1, unsuccessful_crimes = unsuccessful_crimes + 1,
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
    message: success
      ? `✅ You earned $${reward} and ${xpGain} XP`
      : `❌ You failed but still gained ${xpGain} XP`,
    user: updatedUser,
  });
});
