// routes/auth.js
const express = require("express");
const bcrypt = require("bcrypt");
const db = require("../config/db");
const authMiddleware = require("../middlewares/authMiddleware");
const authController = require("../controllers/authController");
const router = express.Router();
router.post("/login", authController.login);
// Create user
router.post("/register", authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== "super_admin") {
      return res
        .status(403)
        .json({ error: "Only super admin can create users" });
    }

    const { username, password, role } = req.body;

    // Check if username already exists
    const existingUser = await db("users").where({ username }).first();

    if (existingUser) {
      return res.status(400).json({ error: "Username already exists" });
    }
    const passwordRegex =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        error:
          "Password must contain at least one uppercase letter, one lowercase letter, one special character, and be at least 8 characters long.",
      });
    }
    const password_hash = await bcrypt.hash(password, 10);

    const [userId] = await db("users").insert({
      username,
      password_hash,
      role,
    });

    res.status(201).json({ id: userId, username, role });
  } catch (err) {
    next(err);
  }
});

// Get all users
router.get("/users", authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ error: "Only super admin can view users" });
    }

    // Remove created_at from the query since it doesn't exist in your table
    const users = await db("users")
      .select("id", "username", "role")
      .orderBy("id", "desc"); // Order by id instead of created_at

    res.json(users);
  } catch (err) {
    next(err);
  }
});

// Update user
router.put("/users/:id", authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== "super_admin") {
      return res
        .status(403)
        .json({ error: "Only super admin can update users" });
    }

    const { id } = req.params;
    const { username, password, role } = req.body;

    // Check if user exists
    const existingUser = await db("users").where({ id }).first();

    if (!existingUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if username is being changed and if it already exists
    if (username && username !== existingUser.username) {
      const usernameExists = await db("users")
        .where({ username })
        .whereNot({ id })
        .first();

      if (usernameExists) {
        return res.status(400).json({ error: "Username already exists" });
      }
    }

    // Password validation if provided
    if (password) {
      const passwordRegex =
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;
      if (!passwordRegex.test(password)) {
        return res.status(400).json({
          error:
            "Password must contain at least one uppercase letter, one lowercase letter, one special character, and be at least 8 characters long.",
        });
      }
    }

    const updateData = {
      username: username || existingUser.username,
      role: role || existingUser.role,
    };

    // Only update password if provided
    if (password) {
      updateData.password_hash = await bcrypt.hash(password, 10);
    }

    await db("users").where({ id }).update(updateData);

    // Return updated user (without password)
    const updatedUser = await db("users")
      .select("id", "username", "role")
      .where({ id })
      .first();

    res.json(updatedUser);
  } catch (err) {
    next(err);
  }
});

// Delete user
router.delete("/users/:id", authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== "super_admin") {
      return res
        .status(403)
        .json({ error: "Only super admin can delete users" });
    }

    const { id } = req.params;
    const currentUser = req.user;

    // Prevent users from deleting themselves
    if (parseInt(id) === currentUser.id) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    // Check if user exists
    const existingUser = await db("users").where({ id }).first();

    if (!existingUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Safe Deletion: Unlink resources first
    // 1. Unlink files (keep them, but remove user association)
    await db("files")
      .where({ created_by: id })
      .update({ created_by: null });

    // 2. Unlink folders (keep them, but remove user association)
    await db("folders")
      .where({ created_by: id })
      .update({ created_by: null });

    // 3. Remove permissions (user is gone, so are their rights)
    await db("permissions")
      .where({ user_id: id })
      .delete();

    // 4. Finally delete the user
    await db("users").where({ id }).delete();

    res.json({ message: "User deleted successfully" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
