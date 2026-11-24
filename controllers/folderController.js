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
  getArchivedFoldersByParent,
} = require("../services/folderService");
const { getFileBuffer } = require("../utils/fileContentHelper");
const { isPdfFile, applyPdfStamps } = require("../services/pdfStampService");

const createfolder = async (req, res, next) => {
  try {
    console.log("into the  controller");

    const { name, parent_id } = req.body;

    // Check for duplicate folder name in the same directory
    const duplicateFolder = await knex("folders")
      .where({
        name: name,
        // Handle null parent_id correctly
        parent_id: parent_id || null
      })
      .andWhere("is_deleted", false) // Ignore trash
      .first();

    if (duplicateFolder) {
      return res.status(409).json({
        error: "A folder with this name already exists in this location",
      });
    }

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
      const userRole = req.user.role ? req.user.role.toLowerCase().trim() : "";

      if (userRole === 'super_admin') {
        userFolders = await knex("folders").where("is_deleted", false);
      } else {
        userFolders = await getUserFolders(userId);
      }

      // Filter by parent_id if specified
      if (parent_id) {
        userFolders = userFolders.filter(
          (folder) => folder.parent_id == parent_id
        );
      }
    }

    // Get folders user has permission to access (only for dashboard context)
    let permissionFolders = [];

    // Check role again (reuse variable if scoped correctly, or re-derive)
    const userRoleScope = req.user.role ? req.user.role.toLowerCase().trim() : "";

    if (context !== "favourites" && userRoleScope !== 'super_admin') {
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

    // Check for duplicate names (scoped to the same parent folder)
    const duplicateFolder = await knex("folders")
      .where({ name: trimmedName })
      .where((builder) => {
        if (existingFolder.parent_id === null) {
          builder.whereNull("parent_id");
        } else {
          builder.where({ parent_id: existingFolder.parent_id });
        }
      })
      .whereNot({ id: folderId })
      .andWhere("is_deleted", false) // Ignore deleted folders
      .first();

    if (duplicateFolder) {
      return res.status(409).json({
        error: "A folder with this name already exists in this location",
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



    // Extract paths from body (parallel to files array)
    const paths = req.body.paths;

    const uploadedFiles = await uploadFolder(req.files, parent_id, userId, paths);

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

    const folder = await knex("folders").where({ id: folderId }).first();
    if (!folder || folder.is_deleted) {
      return res.status(404).json({ error: "Folder not found" });
    }

    console.log(`✅ Folder found: ${folder.name} (ID: ${folder.id})`);

    // Collect active files + empty folder paths recursively (S3 + local)
    const collectTree = async (currentFolderId, parentPath = "") => {
      const files = await knex("files")
        .where("folder_id", currentFolderId)
        .andWhere("is_deleted", false)
        .andWhere("is_archived", false);

      const subfolders = await knex("folders")
        .where("parent_id", currentFolderId)
        .andWhere("is_deleted", false);

      const filesWithPath = files.map((file) => ({
        ...file,
        relativePath: parentPath ? `${parentPath}/${file.name}` : file.name,
      }));

      const folderPaths = [];
      if (parentPath) {
        folderPaths.push(parentPath.endsWith("/") ? parentPath : `${parentPath}/`);
      }

      for (const subfolder of subfolders) {
        const subfolderPath = parentPath
          ? `${parentPath}/${subfolder.name}`
          : subfolder.name;
        const nested = await collectTree(subfolder.id, subfolderPath);
        filesWithPath.push(...nested.files);
        folderPaths.push(...nested.folderPaths);
        // Ensure empty subfolders are still represented
        if (nested.files.length === 0) {
          folderPaths.push(`${subfolderPath}/`);
        }
      }

      return { files: filesWithPath, folderPaths };
    };

    const rootPrefix = folder.name;
    const { files: allFiles, folderPaths } = await collectTree(
      folderId,
      rootPrefix
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("Archive error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to create archive" });
      }
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${folder.name}.zip"`
    );
    archive.pipe(res);

    // Always include root folder entry
    archive.append("", { name: `${rootPrefix}/` });

    // Include nested folder entries (including empty ones)
    const uniqueFolders = [...new Set(folderPaths)];
    for (const folderPath of uniqueFolders) {
      if (folderPath && folderPath !== `${rootPrefix}/`) {
        archive.append("", { name: folderPath.endsWith("/") ? folderPath : `${folderPath}/` });
      }
    }

    let added = 0;
    for (const file of allFiles) {
      try {
        let buffer = await getFileBuffer(file);

        // Folder ZIP uses same download stamp rules as single-file download
        if (isPdfFile(file)) {
          try {
            buffer = await applyPdfStamps(buffer, {
              obsolete: !!file.is_archived,
              controlled: !file.is_archived,
            });
          } catch (stampErr) {
            console.warn(
              `⚠️ Stamp skipped for ${file.name}:`,
              stampErr.message
            );
          }
        }

        const relativePath =
          file.relativePath || file.original_name || file.name;
        archive.append(buffer, { name: relativePath });
        added += 1;
        console.log(`📄 Added to zip: ${relativePath}`);
      } catch (fileErr) {
        console.error(
          `⚠️ Skipping file ${file.name} (${file.file_path}):`,
          fileErr.message
        );
      }
    }

    console.log(
      `✅ Folder zip ready: ${added}/${allFiles.length} files, ${uniqueFolders.length} folder paths`
    );
    await archive.finalize();
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
    if (err.message.includes("already exists")) {
      return res.status(409).json({ error: err.message });
    }
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

const getArchivedFoldersController = async (req, res, next) => {
  try {
    const parentId =
      req.query.parent_id !== undefined &&
      req.query.parent_id !== null &&
      req.query.parent_id !== "" &&
      req.query.parent_id !== "null"
        ? parseInt(req.query.parent_id, 10)
        : null;
    const folders = await getArchivedFoldersByParent(
      req.user.id,
      req.user.role,
      parentId
    );
    res.json({ folders });
  } catch (err) {
    console.error("Error in getArchivedFoldersController:", err);
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
  getArchivedFoldersController,
};
