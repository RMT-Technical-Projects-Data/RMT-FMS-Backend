// routes/fileRoutes.js - Remove express-fileupload and use only Multer
const express = require("express");
const multer = require("multer");
const jwt = require("jsonwebtoken");

const {
  uploadFiles,
  uploadFolderWithFiles,
  downloadFile,
  getFiles,
  updateFileDetails,
  deleteFileById,
  toggleFileFavouriteController,
  getFavouriteFilesController,
  getTrashFilesController,
  restoreFileController,
  permanentDeleteFileController,
  openFile,
  moveFileController,
} = require("../controllers/fileController");
const authMiddleware = require("../middlewares/authMiddleware");
const checkPermission = require("../middlewares/permissionMiddleware");
const path = require("path"); // Add this if missing
const fs = require("fs"); // Add this if missing
const router = express.Router();
const db = require("../config/db");
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
// Configure Multer for file uploads
// Use Disk Storage - More reliable than memory storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Keep original filename but add unique suffix to avoid conflicts
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const fileExt = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, fileExt);
    // Use original name with unique suffix to avoid conflicts
    cb(null, `${baseName}_${uniqueSuffix}${fileExt}`);
  },
});

// File filter
const fileFilter = (req, file, cb) => {
  cb(null, true);
};

const uploadMultiple = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1 GB per file
    files: 100000,
    fields: 100000,
    parts: 200000,
  },
});

// Multer configuration that preserves folder structure
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 100 * 1024 * 1024, files: 200, fields: 10, parts: 300 },
});

// Regular file upload
router.post(
  "/upload",
  authMiddleware,
  uploadMultiple.array("files", 100),
  (req, res, next) => {
    req.resourceType = "folder";
    req.resourceId = req.body.folder_id || null;
    req.action = "create";
    next();
  },
  checkPermission,
  uploadFiles
);

// Middleware to set resource info for uploads
const setUploadResourceInfo = (req, res, next) => {
  req.resourceType = "folder"; // Uploads are treated as folder operations
  req.resourceId = req.body.folder_id ? parseInt(req.body.folder_id) : null;
  req.action = "create";
  next();
};

// Folder upload - same endpoint but different handling
// Folder upload - Add Multer middleware to process the files with logging
router.post(
  "/upload-folder",
  authMiddleware,
  (req, res, next) => {
    console.log("🔍 [Multer Debug] Starting upload-folder request");
    console.log("🔍 [Multer Debug] Headers:", {
      "content-type": req.headers["content-type"],
      "content-length": req.headers["content-length"],
      authorization: req.headers["authorization"] ? "present" : "missing",
    });
    console.log("🔍 [Multer Debug] Body fields:", Object.keys(req.body));
    console.log("🔍 [Multer Debug] Query params:", req.query);
    next();
  },

  // Use your custom multer instance
  (req, res, next) => {
    uploadMultiple.array("files", 999999999)(req, res, function (err) {
      if (err) {
        console.error("❌ [Multer Error]", err);
        return res.status(400).json({
          message: "File upload failed",
          error: err.message,
        });
      }
      console.log("✅ [Multer Success] Files processed:", {
        count: req.files?.length || 0,
      });
      next();
    });
  },

  uploadFolderWithFiles
);

// Middleware to set resource info for permission checking
const setFileResourceInfo = (req, res, next) => {
  const fileId = parseInt(req.params.id);
  req.resourceType = "file";
  req.resourceId = fileId;

  // Set action based on HTTP method and path
  if (req.method === "GET" && req.path.includes("/download")) {
    req.action = "download";
  } else if (req.method === "GET") {
    req.action = "read";
  } else if (req.method === "PUT") {
    req.action = "edit";
  } else if (req.method === "DELETE") {
    req.action = "delete";
  } else if (req.method === "POST" && req.path.includes("/favourite/toggle")) {
    req.action = "edit";
  } else if (req.method === "POST" && req.path.includes("/move")) {
    req.action = "edit";
  }

  next();
};

// Other routes remain the same...
router.get("/download/:id", authMiddleware, setFileResourceInfo, downloadFile);
router.get("/open/:id/url", authMiddleware, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.user.id;

  const file = await db("files").where({ id: fileId }).first();
  if (!file) return res.status(404).json({ error: "File not found" });

  // Generate short-lived signed token (valid 1 minute)
  const tempToken = jwt.sign({ fileId, userId }, process.env.JWT_SECRET);

  // Use dynamic host to support both localhost and production
  const protocol = req.protocol;
  const host = req.get('host');
  const baseUrl = `${protocol}://${host}/api`;
  const openUrl = `${baseUrl}/files/open/direct/${fileId}?token=${tempToken}`;
  res.json({ url: openUrl });
});
router.get("/open/direct/:id", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(401).json({ error: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const fileId = parseInt(req.params.id);

    if (decoded.fileId !== fileId)
      return res.status(403).json({ error: "Invalid token for this file" });

    const file = await db("files").where({ id: fileId }).first();

    if (!file) return res.status(404).json({ error: "File not found" });

    // Robust path resolution (copied from fileController)
    // Robust path resolution strategy
    let filePath = null;
    const candidates = [];

    if (file.file_path) {
      // 1. Try exact path stored in DB
      candidates.push(file.file_path);

      // 2. Try resolving relative to CWD
      candidates.push(path.resolve(process.cwd(), file.file_path));

      // 3. Try resolving 'uploads' relative to CWD (Handle moved/deployed mismatch)
      const normalized = file.file_path.replace(/\\/g, '/');
      const uploadIndex = normalized.indexOf('uploads/');

      if (uploadIndex !== -1) {
        const suffix = normalized.substring(uploadIndex); // e.g. "uploads/folder/file.ext"
        candidates.push(path.join(process.cwd(), suffix));
        candidates.push(path.join(__dirname, '..', suffix));
      } else {
        // If path doesn't contain 'uploads', try prepending it (legacy data)
        candidates.push(path.join(process.cwd(), 'uploads', file.file_path));
      }
    }

    // Check all candidates
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        filePath = p;
        break;
      }
    }

    if (!filePath) {
      console.error(`❌ [open/direct] File not found. Checked candidates:`, candidates);
      return res.status(404).json({ error: "File not found on server" });
    }

    if (!filePath || !fs.existsSync(filePath))
      return res.status(404).json({ error: "File not found" });

    const mime = require("mime-types");
    const mimeType =
      file.mime_type ||
      mime.lookup(filePath) ||
      "application/octet-stream";

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${file.name}"`);

    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("❌ [open/direct] Error:", err);
    return res.status(401).json({ error: "Invalid or expired link" });
  }
});
router.get("/", authMiddleware, getFiles);
router.put(
  "/:id",
  authMiddleware,
  setFileResourceInfo,
  checkPermission,
  updateFileDetails
);
router.delete(
  "/:id",
  authMiddleware,
  setFileResourceInfo,
  checkPermission,
  deleteFileById
);

router.post(
  "/:id/move",
  authMiddleware,
  setFileResourceInfo,
  checkPermission,
  moveFileController
);

// Favourites and Trash routes
router.post(
  "/:id/favourite/toggle",
  authMiddleware,
  setFileResourceInfo,
  checkPermission,
  toggleFileFavouriteController
);
router.get("/favourites", authMiddleware, getFavouriteFilesController);
router.get("/trash", authMiddleware, getTrashFilesController);
router.post("/:id/restore", authMiddleware, restoreFileController);
router.delete("/:id/permanent", authMiddleware, permanentDeleteFileController);

// Favourites navigation routes (with context support)
router.get("/favourites/navigate", authMiddleware, (req, res, next) => {
  // Force context to favourites for this route
  req.query.context = "favourites";
  getFiles(req, res, next);
});

// General navigation route that can handle both dashboard and favourites context
router.get("/navigate", authMiddleware, getFiles);

router.get("/root", authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Get root files created by user
    const userRole = req.user.role ? req.user.role.toLowerCase().trim() : "";

    // Explicitly simple query for Super Admin
    if (userRole === "super_admin") {
      const allRootFiles = await db("files")
        .whereNull("folder_id")
        .andWhere("is_deleted", false)
        .select("*")
        .orderBy("created_at", "desc");

      const filesWithFav = allRootFiles.map(f => ({ ...f, favourited: false }));
      return res.json({ files: filesWithFav });
    }

    const userFiles = await db("files")
      .leftJoin("user_favourite_files", function () {
        this.on("files.id", "=", "user_favourite_files.file_id").andOn(
          "user_favourite_files.user_id",
          "=",
          userId
        );
      })
      .whereNull("files.folder_id")
      .where("files.created_by", userId)
      .andWhere("files.is_deleted", false)
      .select(
        "files.*",
        db.raw(
          "CASE WHEN user_favourite_files.file_id IS NOT NULL THEN true ELSE false END as favourited"
        )
      )
      .orderBy("files.created_at", "desc");

    console.log(
      "🔍 [fileRoutes] User files with favourited:",
      userFiles.length
    );
    if (userFiles.length > 0) {
      console.log(
        "🔍 [fileRoutes] First user file favourited:",
        userFiles[0].favourited
      );
    }

    // Get root files user has permission to access
    const permissionFiles = await db("files")
      .join("permissions", function () {
        this.on("files.id", "=", "permissions.resource_id").andOn(
          "permissions.resource_type",
          "=",
          db.raw("'file'")
        );
      })
      .leftJoin("user_favourite_files", function () {
        this.on("files.id", "=", "user_favourite_files.file_id").andOn(
          "user_favourite_files.user_id",
          "=",
          userId
        );
      })
      .whereNull("files.folder_id")
      .where("permissions.user_id", userId)
      .where("permissions.can_read", true)
      .andWhere("files.is_deleted", false)
      .select(
        "files.*",
        db.raw(
          "CASE WHEN user_favourite_files.file_id IS NOT NULL THEN true ELSE false END as favourited"
        )
      )
      .orderBy("files.created_at", "desc");

    // Combine and deduplicate files
    const allFiles = [...userFiles];
    const existingIds = new Set(userFiles.map((f) => f.id));

    for (const file of permissionFiles) {
      if (!existingIds.has(file.id)) {
        allFiles.push(file);
      }
    }

    console.log(
      "🔍 [fileRoutes] Final response files:",
      allFiles.map((f) => ({
        id: f.id,
        name: f.name,
        favourited: f.favourited,
      }))
    );
    res.json({ files: allFiles });
  } catch (err) {
    next(err);
  }
});
module.exports = router;
