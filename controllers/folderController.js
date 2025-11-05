// controllers/folderController.js
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const knex = require("../config/db");
const {
  createFolder,
  getFolder,
  getUserFolders,
  updateFolder,
  deleteFolder,
  getFolderTree,
  ensureFolderPath,
  saveFile,
  toggleFolderFavourite,
  getFavouriteFolders,
  getTrashFolders,
  restoreFolder,
  permanentDeleteFolder,
} = require("../services/folderService");

const createfolder = async (req, res, next) => {
  try {
    console.log("into the  controller");

    const { name, parent_id } = req.body;
    req.resourceType = "folder";
    req.resourceId = parent_id || null;
    req.action = "create";

    const folder = await createFolder(name, parent_id, req.user.id);
    res.json(folder);
  } catch (err) {
    console.log("error in controller", err);

    next(err);
  }
};

const getfolder = async (req, res, next) => {
  try {
    const folderId = parseInt(req.params.id);
    req.resourceType = "folder";
    req.resourceId = folderId;
    req.action = "read";

    const folder = await getFolder(folderId);
    res.json(folder);
  } catch (err) {
    next(err);
  }
};

const getFolders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { parent_id, context } = req.query;

    let userFolders = [];

    if (context === "favourites") {
      // Fetch all favourite folders (already includes nested structure)
      const favouriteFolders = await getFavouriteFolders(userId);
      const seenFolderIds = new Set();

      const findFoldersInFavourites = (folders, targetParentId) => {
        for (const folder of folders) {
          // Match folders by parent_id
          if (
            folder.parent_id == targetParentId &&
            !seenFolderIds.has(folder.id)
          ) {
            userFolders.push(folder);
            seenFolderIds.add(folder.id);
          }

          // Recursively go deeper into nested_folders
          if (folder.nested_folders?.length > 0) {
            findFoldersInFavourites(folder.nested_folders, targetParentId);
          }
        }
      };

      if (parent_id) {
        // ✅ Get only folders under the given parent
        findFoldersInFavourites(favouriteFolders, parent_id);
        console.log(
          `Found ${userFolders.length} favourite folders under parent_id ${parent_id}`
        );
      } else {
        // ✅ Only return true top-level folders (not nested)
        userFolders = favouriteFolders.filter((f) => f.parent_id === null);
        console.log(
          `Returning ${userFolders.length} top-level favourite folders`
        );
      }
    } else {
      // Default dashboard context
      userFolders = await getUserFolders(userId);

      // Filter by parent_id if specified
      if (parent_id) {
        userFolders = userFolders.filter(
          (folder) => folder.parent_id == parent_id
        );
      }
    }

    // Get folders user has permission to access (only for dashboard context)
    let permissionFolders = [];
    if (context !== "favourites") {
      const permissionQuery = knex("folders")
        .join("permissions", function () {
          this.on("folders.id", "=", "permissions.resource_id").andOn(
            "permissions.resource_type",
            "=",
            knex.raw("'folder'")
          );
        })
        .where("permissions.user_id", userId)
        .where("permissions.can_read", true)
        .andWhere("folders.is_deleted", false);

      if (parent_id) {
        permissionQuery.where("folders.parent_id", parent_id);
      }

      permissionFolders = await permissionQuery.select("folders.*");
    }

    // Combine and deduplicate
    const allFolders = [...userFolders];
    const existingIds = new Set(userFolders.map((f) => f.id));

    for (const folder of permissionFolders) {
      if (!existingIds.has(folder.id)) {
        allFolders.push(folder);
      }
    }

    res.json({ folders: allFolders });
  } catch (err) {
    console.error("Error in getFolders:", err);
    next(err);
  }
};


const updateFolderDetails = async (req, res, next) => {
  try {
    console.log("Update folder request received:", {
      params: req.params,
      body: req.body,
      user: req.user, // if you have user info
    });

    const folderId = parseInt(req.params.id);
    const { name } = req.body;

    // Validate folder ID
    if (isNaN(folderId) || folderId <= 0) {
      return res.status(400).json({
        error: "Invalid folder ID",
        receivedId: req.params.id,
      });
    }

    // Validate name
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({
        error: "Folder name is required and must be a non-empty string",
      });
    }

    const trimmedName = name.trim();

    // Check if folder exists first
    const existingFolder = await knex("folders")
      .where({ id: folderId })
      .first();

    if (!existingFolder) {
      return res.status(404).json({
        error: "Folder not found",
        folderId,
      });
    }

    // Check for duplicate names (if folder names should be unique)
    const duplicateFolder = await knex("folders")
      .where({ name: trimmedName })
      .whereNot({ id: folderId })
      .first();

    if (duplicateFolder) {
      return res.status(409).json({
        error: "A folder with this name already exists",
      });
    }

    req.resourceType = "folder";
    req.resourceId = folderId;
    req.action = "edit";

    console.log("Attempting to update folder:", {
      folderId,
      name: trimmedName,
    });

    const updatedFolder = await updateFolder(folderId, { name: trimmedName });

    console.log("Folder updated successfully:", updatedFolder);

    res.json(updatedFolder);
  } catch (err) {
    console.error("Error in updateFolderDetails:", {
      message: err.message,
      stack: err.stack,
      body: req.body,
      params: req.params,
    });
    next(err);
  }
};

const deleteFolderById = async (req, res, next) => {
  try {
    const folderId = parseInt(req.params.id);

    req.resourceType = "folder";
    req.resourceId = folderId;
    req.action = "delete";

    await deleteFolder(folderId);
    res.json({ message: "Folder deleted successfully" });
  } catch (err) {
    next(err);
  }
};

const getFolderTreeStructure = async (req, res, next) => {
  try {
    const folders = await getFolderTree(req.user.id);
    res.json(folders);
  } catch (err) {
    next(err);
  }
};

// NEW: upload folder with nested structure
// controllers/folderController.js - Update uploadFolderWithFiles

const uploadFolderWithFiles = async (req, res, next) => {
  try {
    const { parent_id = null } = req.body;
    const userId = req.user.id;

    console.log("Upload folder request - Files:", req.files?.length);
    console.log("Parent ID:", parent_id);
    console.log("User ID:", userId);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    // Log file paths for debugging
    req.files.forEach((file, index) => {
      console.log(`File ${index + 1}:`, {
        name: file.name,
        relativePath: file.webkitRelativePath || file.relativePath,
        size: file.size,
      });
    });

    const uploadedFiles = await uploadFolder(req.files, parent_id, userId);

    res.json({
      message: "Folder uploaded successfully with structure preserved",
      files: uploadedFiles,
      total: uploadedFiles.length,
    });
  } catch (error) {
    console.error("Error in uploadFolderWithFiles:", error);
    next(error);
  }
};

const downloadFolder = async (req, res, next) => {
  try {
    const folderId = parseInt(req.params.id);
    console.log(
      `📁 Download folder function called for ID: ${folderId}, User: ${req.user.id}, Role: ${req.user.role}`
    );

    // First check if folder exists in database
    const folder = await knex("folders").where({ id: folderId }).first();
    console.log(
      `🔍 Database check for folder ${folderId}:`,
      folder ? `Found: ${folder.name}` : "NOT FOUND"
    );

    if (!folder) {
      console.log(`❌ Folder ${folderId} not found in database`);
      return res.status(404).json({ error: "Folder not found" });
    }

    console.log(`✅ Folder found: ${folder.name} (ID: ${folder.id})`);

    // Get all files in this folder and subfolders recursively with folder structure
    const getAllFilesInFolder = async (folderId, parentPath = "") => {
      const files = await knex("files").where("folder_id", folderId);
      const subfolders = await knex("folders").where("parent_id", folderId);

      // Add current folder's files with proper path
      const filesWithPath = files.map((file) => ({
        ...file,
        relativePath: parentPath ? `${parentPath}/${file.name}` : file.name,
      }));

      // Process subfolders recursively
      for (const subfolder of subfolders) {
        const subfolderPath = parentPath
          ? `${parentPath}/${subfolder.name}`
          : subfolder.name;
        const subfolderFiles = await getAllFilesInFolder(
          subfolder.id,
          subfolderPath
        );
        filesWithPath.push(...subfolderFiles);
      }

      return filesWithPath;
    };

    const allFiles = await getAllFilesInFolder(folderId);

    if (allFiles.length === 0) {
      console.log(`⚠️ Folder ${folderId} is empty, creating empty zip`);
      // Create an empty zip file instead of returning 404
      const archive = archiver("zip", { zlib: { level: 9 } });

      // Handle archive errors
      archive.on("error", (err) => {
        console.error("Archive error:", err);
        res.status(500).json({ error: "Failed to create archive" });
      });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${folder.name}.zip"`
      );
console.log("lets check folder name here", folder.name);

      archive.pipe(res);
      archive.finalize();
      return;
    }

    // Create zip archive
    const archive = archiver("zip", { zlib: { level: 9 } });

    // Handle archive errors
    archive.on("error", (err) => {
      console.error("Archive error:", err);
      res.status(500).json({ error: "Failed to create archive" });
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${folder.name}.zip"`
    );

    archive.pipe(res);

    // Add files to archive with proper folder structure
    for (const file of allFiles) {
      const filePath = file.file_path || file.path;
      if (filePath && fs.existsSync(filePath)) {
        const relativePath =
          file.relativePath || file.original_name || file.name;
        console.log(
          `📄 Adding file to archive: ${filePath} as ${relativePath}`
        );
        archive.file(filePath, { name: relativePath });
      } else {
        console.log(
          `⚠️ File not found or no path: ${file.name} (path: ${filePath})`
        );
      }
    }

    archive.finalize();
  } catch (err) {
    console.error("Error in downloadFolder:", err);
    next(err);
  }
};

const toggleFolderFavouriteController = async (req, res, next) => {
  try {
    const folderId = parseInt(req.params.id);
    const userId = req.user.id;

    console.log("🎯 [toggleFolderFavouriteController] Calling service for folder:", folderId, "user:", userId);
    const result = await toggleFolderFavourite(userId, folderId);
    console.log("🎯 [toggleFolderFavouriteController] Service returned:", result);
    console.log("🎯 [toggleFolderFavouriteController] Sending response:", result);
    res.json(result);
  } catch (err) {
    console.error("Error in toggleFolderFavouriteController:", err);
    next(err);
  }
};

// router.get("/favourites", authMiddleware, getFavouriteFoldersController);

const getFavouriteFoldersController = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const folders = await getFavouriteFolders(userId);
    res.json({ folders });
  } catch (err) {
    console.error("Error in getFavouriteFoldersController:", err);
    next(err);
  }
};

const getTrashFoldersController = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const parentId = req.query.parent_id ? parseInt(req.query.parent_id) : null;
    const folders = await getTrashFolders(userId, parentId);
    res.json({ folders });
  } catch (err) {
    console.error("Error in getTrashFoldersController:", err);
    next(err);
  }
};

const restoreFolderController = async (req, res, next) => {
  try {
    const folderId = parseInt(req.params.id);
    const result = await restoreFolder(folderId);
    res.json(result);
  } catch (err) {
    console.error("Error in restoreFolderController:", err);
    next(err);
  }
};

const permanentDeleteFolderController = async (req, res, next) => {
  try {
    const folderId = parseInt(req.params.id);
    const result = await permanentDeleteFolder(folderId);
    res.json(result);
  } catch (err) {
    console.error("Error in permanentDeleteFolderController:", err);
    next(err);
  }
};

module.exports = {
  createfolder,
  getfolder,
  getFolders,
  updateFolderDetails,
  deleteFolderById,
  getFolderTreeStructure,
  uploadFolderWithFiles,
  downloadFolder,
  toggleFolderFavouriteController,
  getFavouriteFoldersController,
  getTrashFoldersController,
  restoreFolderController,
  permanentDeleteFolderController,
};
