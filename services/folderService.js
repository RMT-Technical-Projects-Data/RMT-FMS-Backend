// services/folderService.js
const fs = require("fs");
const path = require("path");
const knex = require("../config/db");

// ensure nested folder structure exists
// services/folderService.js - Improve ensureFolderPath

const ensureFolderPath = async (folderPath, parentId, userId) => {
  if (!folderPath || folderPath === "." || folderPath === "/") {
    return parentId;
  }

  const parts = folderPath.split(/[\\/]/).filter((p) => p && p.trim() !== "");
  let currentParentId = parentId;

  for (const folderName of parts) {
    if (!folderName || folderName.trim() === "") continue;

    // Check if folder already exists
    let folder = await knex("folders")
      .where({
        name: folderName,
        parent_id: currentParentId,
      })
      .first();

    // Create folder if it doesn't exist
    if (!folder) {
      const [folderId] = await knex("folders").insert({
        name: folderName,
        parent_id: currentParentId,
        created_by: userId,
        created_at: new Date(),
        updated_at: new Date(),
      });

      folder = { id: folderId, name: folderName };
      console.log(`Created folder: ${folderName} with ID: ${folderId}`);
    }

    currentParentId = folder.id;
  }

  return currentParentId;
};
// create single folder
const createFolder = async (name, parentId, userId) => {
  const [folderId] = await knex("folders").insert({
    name,
    parent_id: parentId,
    created_by: userId,
    created_at: new Date(),
  });
  return { id: folderId, name, parent_id: parentId };
};

// save file (physically + DB)
const saveFile = async (file, folderId, userId) => {
  const uploadDir = path.join(__dirname, "..", "uploads", String(folderId));
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const filePath = path.join(uploadDir, file.name);
  await file.mv(filePath);

  const [fileId] = await knex("files").insert({
    name: file.name,
    folder_id: folderId,
    created_by: userId,
    size: file.size,
    mime_type: file.mimetype,
    path: filePath,
    created_at: new Date(),
    updated_at: new Date(),
  });

  return { id: fileId, name: file.name, folder_id: folderId };
};

const getFolder = async (id) => {
  const folder = await knex("folders").where({ id }).first();
  return folder; // Return null if not found, let permission middleware handle access control
};

const getUserFolders = async (userId) => {
  const result = await knex("folders")
    .leftJoin("user_favourite_folders", function () {
      this.on("folders.id", "=", "user_favourite_folders.folder_id")
        .andOn("user_favourite_folders.user_id", "=", userId);
    })
    .select("folders.*", knex.raw("CASE WHEN user_favourite_folders.folder_id IS NOT NULL THEN true ELSE false END as favourited"))
    .where({ created_by: userId })
    .andWhere("is_deleted", false)
    .orderBy("created_at", "desc");

  console.log("🔍 [getUserFolders] Result for user:", userId, "folders:", result.length);
  if (result.length > 0) {
    console.log("🔍 [getUserFolders] First folder favourited:", result[0].favourited);
  }

  return result;
};

const updateFolder = async (folderId, updates) => {
  try {
    console.log("Database update operation:", { folderId, updates });

    // First, check if the folder exists
    const existingFolder = await knex("folders")
      .where({ id: folderId })
      .first();

    if (!existingFolder) {
      throw new Error(`Folder with ID ${folderId} not found`);
    }

    // Perform the update
    const updateResult = await knex("folders")
      .where({ id: folderId })
      .update({
        ...updates,
        updated_at: new Date(),
      });

    console.log("Update result:", updateResult); // Should be 1 if successful, 0 if failed

    if (updateResult === 0) {
      throw new Error(
        "No rows were updated - folder may not exist or data is unchanged"
      );
    }

    // Fetch the updated folder separately
    const updatedFolder = await knex("folders").where({ id: folderId }).first();

    if (!updatedFolder) {
      throw new Error("Failed to fetch updated folder data");
    }

    return updatedFolder;
  } catch (err) {
    console.error("Database update error:", {
      message: err.message,
      folderId,
      updates,
    });
    throw err;
  }
};

const deleteFolder = async (folderId) => {
  // Soft delete folder and cascade to children and files
  // Mark current folder
  await knex("folders")
    .where({ id: folderId })
    .update({ is_deleted: true, updated_at: new Date() });

  // Mark files in this folder
  await knex("files")
    .where({ folder_id: folderId })
    .update({ is_deleted: true, updated_at: new Date() });

  // Recurse into subfolders
  const subfolders = await knex("folders").where({ parent_id: folderId });
  for (const subfolder of subfolders) {
    await deleteFolder(subfolder.id);
  }
};

const getFolderTree = async (userId) => {
  const folders = await knex("folders")
    .select("id", "name", "parent_id")
    .where({ created_by: userId })
    .andWhere("is_deleted", false);

  const folderMap = new Map();
  const rootFolders = [];

  // Initialize map
  folders.forEach((folder) => {
    folder.nested_folders = [];
    folderMap.set(folder.id, folder);
  });

  // Build tree
  folders.forEach((folder) => {
    if (folder.parent_id) {
      const parent = folderMap.get(folder.parent_id);
      if (parent) {
        parent.nested_folders.push(folder);
      } else {
        // Parent might be deleted or not found, treat as root or ignore?
        // For now, if parent not found in this set, ignore or add to root if appropriate.
        // But since we filtered by user, maybe parent belongs to another user?
        // Safest is to only add if parent exists.
      }
    } else {
      rootFolders.push(folder);
    }
  });

  return rootFolders;
};
// Recursively get all nested folder IDs
const getAllNestedFolderIds = async (parentId) => {
  const children = await knex("folders")
    .where({ parent_id: parentId })
    .andWhere("is_deleted", false)
    .select("id");

  let allIds = children.map((c) => c.id);

  for (const child of children) {
    const nested = await getAllNestedFolderIds(child.id);
    allIds = [...allIds, ...nested];
  }

  return allIds;
};

// Get all file IDs in this folder and its nested folders
const getAllNestedFileIds = async (folderId) => {
  const folderIds = [folderId, ...(await getAllNestedFolderIds(folderId))];
  const files = await knex("files")
    .whereIn("folder_id", folderIds)
    .andWhere("is_deleted", false)
    .select("id");

  return files.map((f) => f.id);
};

const toggleFolderFavourite = async (userId, folderId) => {
  console.log("🔄 [toggleFolderFavourite] Starting toggle for folder:", folderId, "user:", userId);

  // Check if folder exists
  const folder = await knex("folders").where({ id: folderId }).first();
  if (!folder) throw new Error("Folder not found");

  // Check if user already favourited it
  const existing = await knex("user_favourite_folders")
    .where({ user_id: userId, folder_id: folderId })
    .first();

  console.log("🔍 [toggleFolderFavourite] Existing record:", existing);

  if (existing) {
    // UNFAVOURITE - Delete from table
    await knex("user_favourite_folders")
      .where({ user_id: userId, folder_id: folderId })
      .del();

    console.log("❌ [toggleFolderFavourite] Unfavourited folder:", folderId);
    return { id: folderId, favourited: false };
  } else {
    // FAVOURITE - Insert into table
    await knex("user_favourite_folders")
      .insert({
        user_id: userId,
        folder_id: folderId,
        created_at: new Date()
      });

    console.log("✅ [toggleFolderFavourite] Favourited folder:", folderId);
    return { id: folderId, favourited: true };
  }
};


const getFavouriteFolders = async (userId) => {
  // 1️⃣ Fetch all directly favourited folders
  const favouriteFolders = await knex("folders")
    .join(
      "user_favourite_folders",
      "folders.id",
      "=",
      "user_favourite_folders.folder_id"
    )
    .where("user_favourite_folders.user_id", userId)
    .andWhere("folders.is_deleted", false)
    .select("folders.*", knex.raw("true as favourited"))
    .orderBy("user_favourite_folders.created_at", "desc");

  const result = [];
  const seenFolderIds = new Set();

  // 2️⃣ Build hierarchy, avoiding duplication
  for (const folder of favouriteFolders) {
    // Skip duplicates
    if (seenFolderIds.has(folder.id)) continue;
    seenFolderIds.add(folder.id);

    const nestedFolders = await getNestedFolders(
      folder.id,
      userId,
      seenFolderIds
    );
    const nestedFiles = await getNestedFiles(folder.id, userId);

    result.push({
      ...folder,
      nested_folders: nestedFolders,
      nested_files: nestedFiles,
    });
  }

  return result;
};

// Recursive helper for nested folders
const getNestedFolders = async (
  parentId,
  userId,
  seenFolderIds = new Set()
) => {
  const directChildren = await knex("folders")
    .where({ parent_id: parentId })
    .andWhere("is_deleted", false)
    .orderBy("created_at", "desc");

  const result = [];

  for (const child of directChildren) {
    // Avoid duplicates globally
    if (seenFolderIds.has(child.id)) continue;
    seenFolderIds.add(child.id);

    // Check read permission
    const hasPermission = await knex("permissions")
      .where({
        user_id: userId,
        resource_id: child.id,
        resource_type: "folder",
      })
      .andWhere("can_read", true)
      .first();

    if (child.created_by === userId || hasPermission) {
      const nestedFolders = await getNestedFolders(
        child.id,
        userId,
        seenFolderIds
      );
      const nestedFiles = await getNestedFiles(child.id, userId);

      result.push({
        ...child,
        nested_folders: nestedFolders,
        nested_files: nestedFiles,
      });
    }
  }

  return result;
};

// Nested files helper (fine as-is)
// const getNestedFiles = async (folderId, userId) => {
//   return knex("files")
//     .where({ folder_id: folderId })
//     .andWhere("is_deleted", false)
//     .orderBy("created_at", "desc");
// };

// Recursive helper for nested folders
// const getNestedFolders = async (
//   parentId,
//   userId,
//   seenFolderIds = new Set()
// ) => {
//   const directChildren = await knex("folders")
//     .where({ parent_id: parentId })
//     .andWhere("is_deleted", false)
//     .orderBy("created_at", "desc");

//   const result = [];

//   for (const child of directChildren) {
//     // Avoid duplicates globally
//     if (seenFolderIds.has(child.id)) continue;
//     seenFolderIds.add(child.id);

//     // Check read permission
//     const hasPermission = await knex("permissions")
//       .where({
//         user_id: userId,
//         resource_id: child.id,
//         resource_type: "folder",
//       })
//       .andWhere("can_read", true)
//       .first();

//     if (child.created_by === userId || hasPermission) {
//       const nestedFolders = await getNestedFolders(
//         child.id,
//         userId,
//         seenFolderIds
//       );
//       const nestedFiles = await getNestedFiles(child.id, userId);

//       result.push({
//         ...child,
//         nested_folders: nestedFolders,
//         nested_files: nestedFiles,
//       });
//     }
//   }

//   return result;
// };

// Nested files helper (fine as-is)
const getNestedFiles = async (folderId, userId) => {
  return knex("files")
    .where({ folder_id: folderId })
    .andWhere("is_deleted", false)
    .orderBy("created_at", "desc");
};

const getTrashFolders = async (userId, parentId = null) => {
  console.log(
    `🔍 Backend getTrashFolders called - userId: ${userId}, parentId: ${parentId}`
  );

  if (parentId === null) {
    // Get only root-level deleted folders (folders with no parent or whose parent is not deleted)
    const folders = await knex("folders")
      .where({ created_by: userId })
      .andWhere("is_deleted", true)
      .andWhere(function () {
        this.whereNull("parent_id").orWhereNotExists(function () {
          this.select("*")
            .from("folders as parent")
            .whereRaw("parent.id = folders.parent_id")
            .andWhere("parent.is_deleted", true);
        });
      })
      .orderBy("created_at", "desc");

    console.log(
      `📁 Backend returning ${folders.length} root-level trash folders:`,
      folders.map((f) => ({ id: f.id, name: f.name, parent_id: f.parent_id }))
    );
    return folders;
  } else {
    // Get folders within a specific parent folder
    const folders = await knex("folders")
      .where({ created_by: userId, parent_id: parentId })
      .andWhere("is_deleted", true)
      .orderBy("created_at", "desc");

    console.log(
      `📁 Backend returning ${folders.length} trash folders for parent ${parentId}:`,
      folders.map((f) => ({ id: f.id, name: f.name, parent_id: f.parent_id }))
    );
    return folders;
  }
};

const restoreFolder = async (folderId) => {
  // Restore folder and all its children recursively
  await knex("folders")
    .where({ id: folderId })
    .update({ is_deleted: false, updated_at: new Date() });

  // Get all child folders
  const childFolders = await knex("folders")
    .where({ parent_id: folderId })
    .andWhere("is_deleted", true)
    .select("id");

  // Restore all child folders recursively
  for (const child of childFolders) {
    await restoreFolder(child.id);
  }

  // Restore all files in this folder
  await knex("files")
    .where({ folder_id: folderId })
    .andWhere("is_deleted", true)
    .update({ is_deleted: false, updated_at: new Date() });

  return { id: folderId, restored: true };
};

const permanentDeleteFolder = async (folderId) => {
  // Get folder info before deletion
  const folder = await knex("folders").where({ id: folderId }).first();
  if (!folder) {
    throw new Error("Folder not found");
  }

  // Get all child folders
  const childFolders = await knex("folders")
    .where({ parent_id: folderId })
    .andWhere("is_deleted", true)
    .select("id");

  // Permanently delete all child folders recursively
  for (const child of childFolders) {
    await permanentDeleteFolder(child.id);
  }

  // Permanently delete all files in this folder
  const files = await knex("files")
    .where({ folder_id: folderId })
    .andWhere("is_deleted", true)
    .select("*");

  for (const file of files) {
    // Delete physical file
    const fs = require("fs");
    if (file.file_path && fs.existsSync(file.file_path)) {
      fs.unlinkSync(file.file_path);
    }
  }

  // Delete file records
  await knex("files")
    .where({ folder_id: folderId })
    .andWhere("is_deleted", true)
    .del();

  // Construct the full folder path BEFORE deleting the folder record
  const getFolderPath = async (folderId) => {
    const folder = await knex("folders").where({ id: folderId }).first();
    if (!folder) return null;

    const pathParts = [folder.name];
    let currentParentId = folder.parent_id;

    // Build path by traversing up the hierarchy
    while (currentParentId) {
      const parentFolder = await knex("folders")
        .where({ id: currentParentId })
        .first();
      if (parentFolder) {
        pathParts.unshift(parentFolder.name);
        currentParentId = parentFolder.parent_id;
      } else {
        break;
      }
    }

    return path.join(__dirname, "..", "uploads", ...pathParts);
  };

  // Get the full folder path BEFORE deleting the folder record
  const folderPath = await getFolderPath(folderId);

  // Delete folder record
  await knex("folders").where({ id: folderId }).del();

  // Remove physical folder directory from uploads folder
  if (folderPath && fs.existsSync(folderPath)) {
    try {
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log(`🗑️ Removed physical folder directory: ${folderPath}`);
    } catch (error) {
      console.error(`❌ Error removing folder directory ${folderPath}:`, error);
    }
  } else {
    console.log(`ℹ️ Folder path not found or doesn't exist: ${folderPath}`);
  }

  // Clean up ALL empty directories in uploads folder
  const cleanupAllEmptyDirectories = () => {
    try {
      const uploadsDir = path.join(__dirname, "..", "uploads");

      if (!fs.existsSync(uploadsDir)) {
        return;
      }

      const removeEmptyDirs = (dir) => {
        if (!fs.existsSync(dir)) return;

        const files = fs.readdirSync(dir);

        // Recursively process subdirectories first
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            removeEmptyDirs(filePath);
          }
        }

        // Check if directory is empty after processing subdirectories
        const remainingFiles = fs.readdirSync(dir);
        if (remainingFiles.length === 0 && dir !== uploadsDir) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`🗑️ Removed empty directory: ${dir}`);
        }
      };

      removeEmptyDirs(uploadsDir);
    } catch (error) {
      console.error(`❌ Error cleaning up empty directories:`, error);
    }
  };

  // Clean up all empty directories in uploads
  cleanupAllEmptyDirectories();

  return { id: folderId, permanentlyDeleted: true };
};

module.exports = {
  ensureFolderPath,
  createFolder,
  getFolder,
  getUserFolders,
  updateFolder,
  deleteFolder,
  getFolderTree,
  saveFile,
  toggleFolderFavourite,
  getFavouriteFolders,
  getTrashFolders,
  getNestedFolders,
  getNestedFiles,
  restoreFolder,
  permanentDeleteFolder,
};
