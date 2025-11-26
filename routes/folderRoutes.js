const express = require("express");
const {
  createfolder,
  getfolder,
  getFolders,
  updateFolderDetails,
  deleteFolderById,
  getFolderTreeStructure,
  downloadFolder,
  toggleFolderFavouriteController,
  getFavouriteFoldersController,
  getTrashFoldersController,
  restoreFolderController,
  permanentDeleteFolderController,
} = require("../controllers/folderController");
const authMiddleware = require("../middlewares/authMiddleware");
const checkPermission = require("../middlewares/permissionMiddleware");
const db = require("../config/db");
const router = express.Router();

// ✅ CORRECT ORDER: Specific routes first, dynamic routes last

// Folder CRUD operations
router.post("/", authMiddleware, checkPermission, createfolder);
router.get("/", authMiddleware, getFolders);

// ✅ Add /root route BEFORE /:id
router.get("/root", authMiddleware, async (req, res, next) => {
  console.log("into the get root folders");

  try {
    const userId = req.user.id;

    // 1. Get root folders created by user (for display)
    const userFolders = await db("folders")
      .leftJoin("user_favourite_folders", function () {
        this.on("folders.id", "=", "user_favourite_folders.folder_id")
          .andOn("user_favourite_folders.user_id", "=", userId);
      })
      .whereNull("folders.parent_id")
      .where("folders.created_by", userId)
      .andWhere("folders.is_deleted", false)
      .select("folders.*", db.raw("CASE WHEN user_favourite_folders.folder_id IS NOT NULL THEN true ELSE false END as favourited"))
      .orderBy("folders.created_at", "desc");

    // 2. Get ALL folders created by user (IDs only) to check ownership of parents
    const userOwnedIds = await db("folders")
      .where("created_by", userId)
      .andWhere("is_deleted", false)
      .pluck("id");

    const userOwnedIdSet = new Set(userOwnedIds);

    // 3. Get ALL folders user has permission to access (nested or root)
    const permissionFolders = await db("folders")
      .join("permissions", function () {
        this.on("folders.id", "=", "permissions.resource_id")
          .andOn("permissions.resource_type", "=", db.raw("'folder'"));
      })
      .leftJoin("user_favourite_folders", function () {
        this.on("folders.id", "=", "user_favourite_folders.folder_id")
          .andOn("user_favourite_folders.user_id", "=", userId);
      })
      // REMOVED: .whereNull("folders.parent_id") - We want all permitted folders
      .where("permissions.user_id", userId)
      .where("permissions.can_read", true)
      .andWhere("folders.is_deleted", false)
      .select("folders.*", db.raw("CASE WHEN user_favourite_folders.folder_id IS NOT NULL THEN true ELSE false END as favourited"))
      .orderBy("folders.created_at", "desc");

    // 4. Create a Set of all accessible folder IDs (owned + permitted)
    const permittedIdSet = new Set(permissionFolders.map(f => f.id));
    const allAccessibleIds = new Set([...userOwnedIdSet, ...permittedIdSet]);

    // 5. Filter permissionFolders
    // Show a folder if:
    // - It is a root folder (parent_id is null)
    // - OR its parent is NOT accessible (not owned AND not in permission list)
    const visiblePermissionFolders = permissionFolders.filter(folder => {
      if (!folder.parent_id) return true; // It's a root folder, show it

      // If parent is accessible, HIDE this folder (user can navigate to it via parent)
      if (allAccessibleIds.has(folder.parent_id)) return false;

      // Parent is NOT accessible, so SHOW this folder at root
      return true;
    });

    // 6. Combine and deduplicate
    const allFolders = [...userFolders];
    const existingIds = new Set(userFolders.map(f => f.id));

    for (const folder of visiblePermissionFolders) {
      if (!existingIds.has(folder.id)) {
        allFolders.push(folder);
      }
    }

    console.log(`Found ${allFolders.length} root/accessible folders`);
    res.json({ folders: allFolders });
  } catch (err) {
    console.log("error in getting root folders", err);
    next(err);
  }
});

// Middleware to set resource info for permission checking
const setResourceInfo = (req, res, next) => {
  const folderId = parseInt(req.params.id);
  req.resourceType = "folder";
  req.resourceId = folderId;

  // Set action based on HTTP method
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
  }

  console.log(`🔧 setResourceInfo: Set resourceType=${req.resourceType}, resourceId=${req.resourceId}, action=${req.action}`);
  next();
};

router.get("/tree/structure", authMiddleware, getFolderTreeStructure);

// Favourites and Trash routes
router.post("/:id/favourite/toggle", authMiddleware, setResourceInfo, checkPermission, toggleFolderFavouriteController);
router.get("/favourites", authMiddleware, getFavouriteFoldersController);
router.get("/trash", authMiddleware, getTrashFoldersController);
router.post("/:id/restore", authMiddleware, restoreFolderController);
router.delete("/:id/permanent", authMiddleware, permanentDeleteFolderController);

// ⚠️ Dynamic routes should come AFTER specific routes
// IMPORTANT: More specific routes must come before general ones

// Favourites navigation routes (with context support)
router.get("/favourites/navigate", authMiddleware, (req, res, next) => {
  // Force context to favourites for this route
  req.query.context = 'favourites';
  getFolders(req, res, next);
});

// General navigation route that can handle both dashboard and favourites context
router.get("/navigate", authMiddleware, getFolders);

// Dynamic routes (must come after specific routes)
router.get("/:id/download", authMiddleware, setResourceInfo, checkPermission, downloadFolder);
router.get("/:id", authMiddleware, setResourceInfo, checkPermission, getfolder);
router.put("/:id", authMiddleware, setResourceInfo, checkPermission, updateFolderDetails);
router.delete("/:id", authMiddleware, setResourceInfo, checkPermission, deleteFolderById);

module.exports = router;
