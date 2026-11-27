const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { logActivity, getClientIp } = require("../services/auditService");

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const ipAddress = getClientIp(req);

    const user = await db("users").where({ username }).first();
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      try {
        await logActivity({
          userId: null,
          username: username || "Unknown",
          action: "login_failed",
          resourceType: "auth",
          details: "Invalid credentials",
          ipAddress,
          status: "failed",
        });
      } catch (_) {}
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "30m" }
    );

    try {
      await logActivity({
        userId: user.id,
        username: user.username,
        action: "login",
        resourceType: "auth",
        details: `Role: ${user.role}`,
        ipAddress,
        status: "success",
      });
    } catch (auditErr) {
      console.error("⚠️ login audit failed:", auditErr.message);
    }

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
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

    try {
      await logActivity({
        userId: req.user?.id || null,
        username: req.user?.username || "Unknown",
        action: "create_user",
        resourceType: "user",
        resourceId: userId,
        resourceName: username,
        details: `Created user with role ${role}`,
        ipAddress: getClientIp(req),
      });
    } catch (_) {}

    res.json({ id: userId, username, role });
  } catch (err) {
    console.log(err);
    next(err);
  }
};

module.exports = { login, createUser };
