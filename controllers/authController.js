const db = require("../config/db"); // ✅ use the db.js
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    const user = await db("users").where({ username }).first();
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ token, user: { id: user.id, username, role: user.role } });
  } catch (err) {
    console.log(err);
    next(err);
  }
};

const createUser = async (req, res, next) => {
  try {
    const { username, password, role } = req.body;
    const password_hash = await bcrypt.hash(password, 10);

    const [userId] = await db("users").insert({
      username,
      password_hash,
      role,
    });

    res.json({ id: userId, username, role });
  } catch (err) {
    console.log(err);
    next(err);
  }
};

module.exports = { login, createUser };
