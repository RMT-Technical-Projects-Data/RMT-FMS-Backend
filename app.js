require("dotenv").config();

const createError = require("http-errors");
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const logger = require("morgan");
const cors = require("cors");

// Import routes
const authRoutes = require("./routes/authRoutes");
const folderRoutes = require("./routes/folderRoutes");
const fileRoutes = require("./routes/fileRoutes");
const permissionRoutes = require("./routes/permissionRoutes");
const sharedRoutes = require("./routes/sharedRoutes");
const indexRouter = require("./routes/index");
const usersRouter = require("./routes/users");

// Import middlewares
const errorMiddleware = require("./middlewares/errorMiddleware");

const app = express();

// View engine setup
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "jade");

// For development - allow all origins (remove in production)
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      const allowedOrigins = [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://13.233.6.224:3005",
        "http://13.233.6.224",
        "https://13.233.6.224:3005",
        "https://13.233.6.224",
        "http://rmtfms.duckdns.org",
        "https://rmtfms.duckdns.org",
      ];

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        console.log("Blocked by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposedHeaders: ["Content-Disposition"],
  })
);
app.use(logger("dev"));
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: false, limit: "500mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Serve uploaded files statically
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use("/", indexRouter);
app.use("/users", usersRouter);

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/folders", folderRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/shared", sharedRoutes);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

// Catch 404 and forward to error handler
app.use((req, res, next) => {
  next(createError(404));
});

// Error handler
app.use((err, req, res, next) => {
  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "development" ? err : {};
  res.status(err.status || 500);
  res.render("error");
});

// Custom error middleware
app.use(errorMiddleware);

// ---------------------------
// CRON JOB: Auto-delete trash > 30 days
// ---------------------------
const { permanentDeleteFolder } = require("./services/folderService");
const { permanentDeleteFile } = require("./services/fileService");
const knex = require("./config/db");

const cleanupTrash = async () => {
  try {
    console.log("🧹 [CRON] Starting trash cleanup...");
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 1. Find folders to delete
    const foldersToDelete = await knex("folders")
      .where("is_deleted", true)
      .andWhere("deleted_at", "<", thirtyDaysAgo)
      .select("id", "name");

    for (const folder of foldersToDelete) {
      console.log(`🗑️ [CRON] Auto-deleting folder: ${folder.name} (${folder.id})`);
      await permanentDeleteFolder(folder.id);
    }

    // 2. Find files to delete
    const filesToDelete = await knex("files")
      .where("is_deleted", true)
      .andWhere("deleted_at", "<", thirtyDaysAgo)
      .select("id", "name");

    for (const file of filesToDelete) {
      console.log(`🗑️ [CRON] Auto-deleting file: ${file.name} (${file.id})`);
      await permanentDeleteFile(file.id);
    }

    if (foldersToDelete.length > 0 || filesToDelete.length > 0) {
      console.log(`✅ [CRON] Cleanup complete. Deleted ${foldersToDelete.length} folders and ${filesToDelete.length} files.`);
    } else {
      console.log("✅ [CRON] No items to clean up.");
    }
  } catch (error) {
    console.error("❌ [CRON] Error during trash cleanup:", error);
  }
};

// Run cleanup every day at midnight (or on server start for now)
// Using setInterval for simplicity (24 hours)
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
setInterval(cleanupTrash, TWENTY_FOUR_HOURS);

// Run once on startup to check immediately
setTimeout(cleanupTrash, 10000); // Wait 10s for DB connection


// ---------------------------
// START THE SERVER
// ---------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});

module.exports = app;
