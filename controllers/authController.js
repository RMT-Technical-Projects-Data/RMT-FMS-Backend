const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const {
  logActivity,
  getClientIp,
  getDeviceIp,
  getDeviceMac,
  auditFromReq,
} = require("../services/auditService");

const login = async (req, res, next) => {
  try {
    const { username, password, sessionMinutes } = req.body;
    const ipAddress = getClientIp(req);
    const deviceIp = getDeviceIp(req) || ipAddress;
    const deviceMac = getDeviceMac(req, deviceIp);

    // Default 5 minutes; allow 1–480 minutes from client settings
    const parsedMins = parseInt(sessionMinutes, 10);
    const sessionMins = Number.isFinite(parsedMins)
      ? Math.min(Math.max(parsedMins, 1), 480)
      : 5;

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
          deviceIp,
          deviceMac,
          status: "failed",
        });
      } catch (_) {}
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: `${sessionMins}m` }
    );

    try {
      await logActivity({
        userId: user.id,
        username: user.username,
        action: "login",
        resourceType: "auth",
        details: `Role: ${user.role}; session ${sessionMins}m`,
        ipAddress,
        deviceIp,
        deviceMac,
        status: "success",
      });
    } catch (auditErr) {
      console.error("⚠️ login audit failed:", auditErr.message);
    }

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
      sessionMinutes: sessionMins,
    });
  } catch (err) {
    console.log(err);
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    await auditFromReq(req, {
      action: "logout",
      resourceType: "auth",
      details: "User signed out",
    });
    res.json({ message: "Logged out" });
  } catch (err) {
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

    await auditFromReq(req, {
      action: "create_user",
      resourceType: "user",
      resourceId: userId,
      resourceName: username,
      details: `Created user with role ${role}`,
    });

    res.json({ id: userId, username, role });
  } catch (err) {
    console.log(err);
    next(err);
  }
};

module.exports = { login, createUser, logout };
