// services/fileService.js
const knex = require("../config/db");
const path = require("path");
const fs = require("fs");
const { uploadFileToS3, deleteFileFromS3, copyFileInS3 } = require("./s3Service");
const {
  findDeletedFolderTwin,
  resolveTrashParentId,
  getFullyArchivedFolderIds,
} = require("./folderService");

const uploadFile = async (file, folderId, userId, customName = null) => {
  console.log("=== UPLOAD FILE SERVICE START ===");
  console.log("File object:", {
    originalname: file.originalname,
    filename: file.filename,
    path: file.path,
    size: file.size,
    mimetype: file.mimetype,
  });

  const trx = await knex.transaction();

  try {
    let fileName = customName || file.originalname;

    // Check for duplicates and rename if necessary
    let checkName = fileName;
    let counter = 1;
    let duplicateExists = true;

    while (duplicateExists) {
      const existingFile = await trx("files")
        .where({
          name: checkName,
          folder_id: folderId || null,
          created_by: userId,
          is_deleted: false
        })
        .first();

      if (existingFile) {
        const lastDotIndex = fileName.lastIndexOf(".");
        if (lastDotIndex !== -1) {
          const namePart = fileName.substring(0, lastDotIndex);
          const extPart = fileName.substring(lastDotIndex);
          checkName = `${namePart} (${counter})${extPart}`;
        } else {
          checkName = `${fileName} (${counter})`;
        }
        counter++;
      } else {
        duplicateExists = false;
      }
    }

    fileName = checkName;

    // --- S3 UPLOAD START ---
    // Generate S3 Key: UserUploads/UserId/[FolderStructure]/FileName
    // For simplicity: UserUploads/{userId}/{folderId or root}/{fileName}
    let folderPath = "";
    if (folderId) {
      folderPath = `${folderId}/`;
    } else {
      folderPath = "root/";
    }
    const s3Key = `UserUploads/${userId}/${folderPath}${fileName}`;

    console.log(`🚀 Uploading to S3 Key: ${s3Key}`);
    await uploadFileToS3(file.path, s3Key, file.mimetype);
    console.log(`✅ Uploaded to S3`);

    // Remove temp file
    if (fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
        console.log("Deleted local temp file");
      } catch (e) { console.warn("Failed to delete temp file", e); }
    }
    // --- S3 UPLOAD END ---

    const fileUrl = `/api/files/${file.filename}/download`; // Values URL stays same for proxying

    // Insert into DB
    const [fileId] = await trx("files").insert({
      name: fileName, // Use the (potentially renamed) filename
      original_name: file.originalname,
      folder_id: folderId || null,
      file_path: s3Key, // Store S3 Key
      file_url: fileUrl,
      mime_type: file.mimetype,
      size: file.size,
      created_by: userId,
      created_at: new Date(),
      updated_at: new Date(),
      // Hidden from dashboard until With/Without Stamp is chosen
      stamp_confirmed: false,
    });

    await trx.commit();

    console.log("File successfully inserted into database with ID:", fileId);

    return {
      id: fileId,
      name: fileName,
      url: `/api/files/${fileId}/download`,
      size: file.size,
      mime_type: file.mimetype,
      file_path: s3Key,
    };
  } catch (error) {
    console.error("Error in uploadFile service:", error);
    await trx.rollback();

    // Clean up the uploaded file if DB insert failed
    if (file && file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
        console.log("Cleaned up file after error:", file.path);
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError);
      }
    }

    throw error;
  }
};

const uploadFolder = async (files, parentId, userId, paths = []) => {
  console.log("🚀 UPLOAD FOLDER SERVICE START");
  console.log("Files count:", files.length);
  console.log("Parent ID:", parentId);
  console.log("User ID:", userId);

  // Ensure paths is an array (might be string if single file)
  const filePaths = Array.isArray(paths) ? paths : (paths ? [paths] : []);
  console.log("Paths provided:", filePaths.length);

  // Validate inputs
  if (!files || files.length === 0) {
    throw new Error("No files provided for upload");
  }

  if (!userId) {
    throw new Error("User ID is required");
  }

  // Convert parentId to null if it's undefined, empty string, or "null" string
  let targetParentId = null;
  if (parentId !== undefined && parentId !== null && parentId !== "" && parentId !== "null") {
    const parsed = parseInt(parentId);
    if (!isNaN(parsed)) {
      targetParentId = parsed;
    }
  }
  console.log("Target parent ID:", targetParentId);

  // Verify user exists
  const user = await knex("users").where({ id: userId }).first();
  if (!user) {
    throw new Error(`User with ID ${userId} not found`);
  }
  console.log("✅ User verified:", user.username);

  const uploadedFiles = [];
  const folderMap = new Map(); // Map to store created folder IDs by path
  const trx = await knex.transaction();

  try {
    console.log("🔍 Starting folder upload process...");

    // Process each file and create necessary folder structure
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Use provided path if available, otherwise originalname
      const providedPath = filePaths[i];
      const filePath = providedPath || file.webkitRelativePath || file.originalname || file.name;

      console.log(`📁 Processing file: ${filePath}`);

      // Normalize path separators to /
      const normalizedPath = filePath.replace(/\\/g, '/');
      const pathParts = normalizedPath.split("/").filter((part) => part.trim().length > 0);

      // Get folder path (everything except the last part which is the filename)
      const folderPathParts = pathParts.slice(0, -1);
      const fileName = pathParts[pathParts.length - 1];

      let currentParentId = targetParentId;

      // Create folder structure if needed
      if (folderPathParts.length > 0) {
        let currentPath = "";

        for (let j = 0; j < folderPathParts.length; j++) {
          const folderName = folderPathParts[j].trim();
          currentPath += (currentPath ? "/" : "") + folderName.toLowerCase();

          if (!folderMap.has(currentPath)) {
            // Check if folder already exists in database (Case Insensitive)
            const existingFolder = await trx("folders")
              .where({ parent_id: currentParentId })
              .andWhereRaw('LOWER(name) = ?', [folderName.toLowerCase()])
              .andWhere("is_deleted", false)
              .first();

            if (existingFolder) {
              console.log(
                `✅ Folder already exists: ${existingFolder.name} (ID: ${existingFolder.id}) - Merging`
              );
              folderMap.set(currentPath, existingFolder.id);
              currentParentId = existingFolder.id;
            } else {
              // Create this folder
              console.log(
                `🔨 Creating folder: ${folderName} with parent_id: ${currentParentId}`
              );
              try {
                const [folderId] = await trx("folders").insert({
                  name: folderName, // Use original casing
                  parent_id: currentParentId,
                  created_by: userId,
                  created_at: new Date(),
                  updated_at: new Date(),
                });

                folderMap.set(currentPath, folderId);
                currentParentId = folderId;
              } catch (insertError) {
                console.error(
                  `❌ ERROR creating folder ${folderName}:`,
                  insertError
                );
                throw insertError;
              }
            }
          } else {
            currentParentId = folderMap.get(currentPath);
          }
        }
      }

      // Check if file already exists in the destination folder
      const existingFile = await trx("files")
        .where({
          folder_id: currentParentId,
          name: fileName,
          is_deleted: false,
          created_by: userId
        })
        .first();

      if (existingFile) {
        console.log(`⚠️ File ${fileName} already exists used in folder ${currentParentId}. Skipping.`);
        continue; // Skip upload for this file
      }

      // --- S3 UPLOAD START ---
      let folderPath = "";
      if (currentParentId) {
        folderPath = `${currentParentId}/`;
      } else {
        folderPath = "root/";
      }
      const s3Key = `UserUploads/${userId}/${folderPath}${fileName}`;

      console.log(`🚀 [FolderUpload] Uploading ${fileName} to S3 Key: ${s3Key}`);
      await uploadFileToS3(file.path, s3Key, file.mimetype);

      // Remove temp file
      if (fs.existsSync(file.path)) {
        try {
          fs.unlinkSync(file.path);
        } catch (e) { console.warn("Failed to delete temp file", e); }
      }
      // --- S3 UPLOAD END ---

      const fileUrl = `/api/files/${file.filename}/download`;

      try {
        const [fileId] = await trx("files").insert({
          name: fileName,
          original_name: file.originalname || file.name,
          folder_id: currentParentId,
          file_path: s3Key, // Store S3 Key
          file_url: fileUrl,
          mime_type: file.mimetype,
          size: file.size,
          created_by: userId,
          created_at: new Date(),
          updated_at: new Date(),
          // Hidden from dashboard until With/Without Stamp is chosen
          stamp_confirmed: false,
        });

        uploadedFiles.push({
          id: fileId,
          name: fileName,
          url: `/api/files/${fileId}/download`,
          size: file.size,
          mime_type: file.mimetype,
          folder_id: currentParentId,
        });
      } catch (fileError) {
        console.error(`❌ ERROR uploading file ${fileName}:`, fileError);
        throw fileError;
      }
    }

    await trx.commit();
    console.log(
      `✅ UPLOAD COMPLETED: Successfully uploaded ${uploadedFiles.length} files`
    );
    return uploadedFiles;

  } catch (error) {
    console.error("❌ UPLOAD ERROR in uploadFolder:", error);
    await trx.rollback();
    throw error;
  }
};

const getFileById = async (fileId) => {
  return knex("files").where({ id: fileId }).first();
};

const getFile = async (fileId) => {
  const file = await getFileById(fileId);
  if (!file) throw new Error("File not found");
  return file;
};

const getUserFiles = async (userId, folder_id = null) => {
  let query = knex("files")
    .leftJoin("folders", "files.folder_id", "folders.id")
    .leftJoin("user_favourite_files", function () {
      this.on("files.id", "=", "user_favourite_files.file_id")
        .andOn("user_favourite_files.user_id", "=", userId);
    })
    .select("files.*", "folders.name as folder_name", knex.raw("CASE WHEN user_favourite_files.file_id IS NOT NULL THEN true ELSE false END as favourited"))
    .where("files.created_by", userId)
    .andWhere("files.is_deleted", false)
    .andWhere("files.is_archived", false)
    .andWhere("files.stamp_confirmed", true);

  if (folder_id) {
    query = query.where("files.folder_id", folder_id);
  }

  const result = await query.orderBy("files.created_at", "desc");

  console.log("🔍 [getUserFiles] Result for user:", userId, "folder:", folder_id, "files:", result.length);
  if (result.length > 0) {
    console.log("🔍 [getUserFiles] First file favourited:", result[0].favourited);
  }

  return result;
};

const updateFile = async (fileId, updates) => {
  await knex("files")
    .where({ id: fileId })
    .update({
      ...updates,
      updated_at: new Date(),
    });

  return knex("files").where({ id: fileId }).first();
};

const deleteFile = async (fileId) => {
  // Get file info
  const file = await knex("files").where({ id: fileId }).first();
  if (!file) throw new Error("File not found");

  const userId = file.created_by;
  const now = new Date();

  // Prefer existing trash folder twin so structure merges on re-delete
  let targetFolderId = file.folder_id;
  try {
    if (file.folder_id) {
      const folder = await knex("folders").where({ id: file.folder_id }).first();
      if (folder && !folder.is_deleted) {
        const trashParentId = await resolveTrashParentId(
          knex,
          folder.parent_id,
          folder.created_by
        );
        const twin = await findDeletedFolderTwin(
          knex,
          folder.name,
          trashParentId,
          folder.created_by,
          folder.id
        );
        if (twin) targetFolderId = twin.id;
      }
    }
  } catch (mapErr) {
    console.warn(
      "⚠️ [deleteFile] Trash folder remap skipped:",
      mapErr.message
    );
    targetFolderId = file.folder_id;
  }

  // S3 Move-to-Trash Logic
  // Determine if it's an S3 file
  const path = require("path");
  const isLocalFile = file.file_path && (path.isAbsolute(file.file_path) || file.file_path.includes("uploads\\") || file.file_path.includes("uploads/"));

  if (!isLocalFile && file.file_path && !file.is_deleted) {
    try {
      const timestamp = Date.now();
      const originalName = file.name;
      const trashKey = `Trash/${userId}/${timestamp}/${originalName}`;

      console.log(`🗑️ [deleteFile] Moving S3 file to Trash: ${trashKey}`);

      // 1. Copy to Trash
      await copyFileInS3(file.file_path, trashKey);

      // 2. Delete original
      await deleteFileFromS3(file.file_path);

      // 3. Update DB with new path (+ optional folder remap into trash twin)
      await knex("files")
        .where({ id: fileId })
        .update({
          file_path: trashKey,
          folder_id: targetFolderId,
          is_deleted: true,
          deleted_at: now,
          updated_at: now,
        });

      return; // Exit as we handled the update
    } catch (err) {
      console.error(`❌ [deleteFile] Error moving to S3 Trash:`, err);
      // Fallback to simple soft delete if S3 ops fail (or re-throw if critical)
      throw err;
    }
  }

  // Legacy/Local Soft Delete (Just DB Flag)
  await knex("files")
    .where({ id: fileId })
    .update({
      folder_id: targetFolderId,
      is_deleted: true,
      deleted_at: now,
      updated_at: now,
    });
};

// ... existing toggleFileFavourite ...
const toggleFileFavourite = async (fileId, userId) => {
  // ... keep existing implementation ...
  // Check if file exists
  const file = await knex("files").where({ id: fileId }).first();
  if (!file) throw new Error("File not found");

  // Check if user has already favourited this file
  const existingFav = await knex("user_favourite_files")
    .where({ user_id: userId, file_id: fileId })
    .first();

  if (existingFav) {
    // Unfavourite (delete record)
    await knex("user_favourite_files")
      .where({ user_id: userId, file_id: fileId })
      .delete();
    return { id: fileId, is_favourited: false };
  } else {
    // Favourite (insert record)
    await knex("user_favourite_files").insert({
      user_id: userId,
      file_id: fileId,
      created_at: new Date(),
    });
    return { id: fileId, is_favourited: true };
  }
};
const getFavouriteFiles = async (userId) => {
  const favouriteFiles = await knex("user_favourite_files as uf")
    .join("files as f", "uf.file_id", "f.id")
    .leftJoin("folders as fo", "f.folder_id", "fo.id")
    .select(
      "f.id",
      "f.name",
      "f.folder_id",
      "fo.name as folder_name",
      "f.file_path",
      "f.file_url",
      "f.mime_type",
      "f.size",
      "f.original_name",
      "f.created_at",
      "f.updated_at",
      "f.is_faviourite",
      "f.is_deleted"
    )
    .where("uf.user_id", userId)
    .andWhere("f.is_deleted", false)
    .orderBy("f.created_at", "desc");

  return favouriteFiles;
};

// Helper function to get all files from a folder recursively
const getFilesFromFolderRecursively = async (folderId, userId) => {
  // Get direct files in this folder
  const directFiles = await knex("files")
    .leftJoin("folders", "files.folder_id", "folders.id")
    .select("files.*", "folders.name as folder_name")
    .where("files.folder_id", folderId)
    .andWhere("files.created_by", userId)
    .andWhere("files.is_deleted", false)
    .orderBy("files.created_at", "desc");

  // Get all subfolders
  const subfolders = await knex("folders")
    .where({ parent_id: folderId, created_by: userId })
    .andWhere("is_deleted", false)
    .select("id");

  // Get files from all subfolders recursively
  let nestedFiles = [];
  for (const subfolder of subfolders) {
    const subfolderFiles = await getFilesFromFolderRecursively(
      subfolder.id,
      userId
    );
    nestedFiles.push(...subfolderFiles);
  }

  return [...directFiles, ...nestedFiles];
};

const getTrashFiles = async (userId, folderId = null) => {
  console.log(
    `🔍 Backend getTrashFiles called - userId: ${userId}, folderId: ${folderId}`
  );

  if (folderId === null) {
    // Get only root-level deleted files (files with no folder or whose folder is not deleted)
    const files = await knex("files")
      .leftJoin("folders", "files.folder_id", "folders.id")
      .select("files.*", "folders.name as folder_name")
      .where("files.created_by", userId)
      .andWhere("files.is_deleted", true)
      .andWhere(function () {
        this.whereNull("files.folder_id").orWhereNotExists(function () {
          this.select("*")
            .from("folders as folder")
            .whereRaw("folder.id = files.folder_id")
            .andWhere("folder.is_deleted", true);
        });
      })
      .orderBy("files.created_at", "desc");

    console.log(
      `📁 Backend returning ${files.length} root-level trash files:`,
      files.map((f) => ({ id: f.id, name: f.name, folder_id: f.folder_id }))
    );
    return files;
  } else {
    // Get files within a specific folder
    const files = await knex("files")
      .leftJoin("folders", "files.folder_id", "folders.id")
      .select("files.*", "folders.name as folder_name")
      .where("files.created_by", userId)
      .andWhere("files.folder_id", folderId)
      .andWhere("files.is_deleted", true)
      .orderBy("files.created_at", "desc");

    console.log(
      `📁 Backend returning ${files.length} trash files for folder ${folderId}:`,
      files.map((f) => ({ id: f.id, name: f.name, folder_id: f.folder_id }))
    );
    return files;
  }
};

/**
 * Ensure a LIVE folder path exists for a trashed file (dashboard).
 * - Reuses an existing live folder with the same name at that level
 * - If the trash folder itself is still live, reuse it
 * - Otherwise CREATE a live twin — never undelete trash folders,
 *   so the trash tree structure stays intact for remaining items
 */
const ensureLiveFolderAncestors = async (trx, folderId) => {
  if (!folderId) return null;

  const folder = await trx("folders").where({ id: folderId }).first();
  if (!folder) return null;

  const resolvedParentId = await ensureLiveFolderAncestors(
    trx,
    folder.parent_id
  );

  let liveQuery = trx("folders").where({
    name: folder.name,
    is_deleted: false,
  });

  if (resolvedParentId == null) {
    liveQuery = liveQuery.whereNull("parent_id");
  } else {
    liveQuery = liveQuery.andWhere("parent_id", resolvedParentId);
  }

  if (folder.created_by != null) {
    liveQuery = liveQuery.andWhere("created_by", folder.created_by);
  }

  const liveMatch = await liveQuery.first();
  if (liveMatch) {
    return liveMatch.id;
  }

  // Original folder still live and already under the resolved parent
  if (
    !folder.is_deleted &&
    (folder.parent_id ?? null) === (resolvedParentId ?? null)
  ) {
    return folder.id;
  }

  // Keep the deleted folder in trash; create a live twin for dashboard
  const insertRow = {
    name: folder.name,
    parent_id: resolvedParentId,
    created_by: folder.created_by,
    created_at: new Date(),
    updated_at: new Date(),
    is_deleted: false,
    deleted_at: null,
  };

  const inserted = await trx("folders").insert(insertRow);
  const newId = Array.isArray(inserted) ? inserted[0] : inserted;

  console.log(
    `♻️ [ensureLiveFolderAncestors] Created live twin "${folder.name}" (${newId}) for trash folder ${folder.id}`
  );
  return newId;
};

// ... restoreFile ...
const restoreFile = async (fileId) => {
  const trx = await knex.transaction();
  try {
    const file = await trx("files").where({ id: fileId }).first();
    if (!file) throw new Error("File not found");
    if (!file.is_deleted) {
      throw new Error("File is not in trash");
    }

    const userId = file.created_by;

    // Rebuild / reuse live ancestor folders for this file only
    const targetFolderId = await ensureLiveFolderAncestors(
      trx,
      file.folder_id
    );

    // Check collision in the destination folder
    let existingQuery = trx("files")
      .where({
        name: file.name,
        created_by: file.created_by,
        is_deleted: false,
      })
      .whereNot("id", fileId);

    if (targetFolderId == null) {
      existingQuery = existingQuery.whereNull("folder_id");
    } else {
      existingQuery = existingQuery.andWhere("folder_id", targetFolderId);
    }

    const existingFile = await existingQuery.first();

    if (existingFile) {
      throw new Error("File already exists");
    }

    // S3 Restore Logic
    const isS3Trash = file.file_path && file.file_path.startsWith("Trash/");

    if (isS3Trash) {
      try {
        const folderPath = targetFolderId ? `${targetFolderId}/` : "root/";
        // Reconstruct original key: UserUploads/{userId}/{folderPath}/{fileName}
        const originalKey = `UserUploads/${userId}/${folderPath}${file.name}`;

        console.log(`♻️ [restoreFile] Restoring from Trash to: ${originalKey}`);

        // 1. Copy back to original location
        await copyFileInS3(file.file_path, originalKey);

        // 2. Delete from Trash
        await deleteFileFromS3(file.file_path);

        // 3. Update DB (including remapped folder if path was reused)
        await trx("files")
          .where({ id: fileId })
          .update({
            file_path: originalKey,
            folder_id: targetFolderId,
            is_deleted: false,
            deleted_at: null,
            updated_at: new Date(),
          });

        await trx.commit();
        return {
          id: fileId,
          restored: true,
          folder_id: targetFolderId,
        };
      } catch (err) {
        console.error(`❌ [restoreFile] Error restoring from S3 Trash:`, err);
        // If S3 fails, we probably shouldn't un-flag it in DB
        throw err;
      }
    }

    // Local/Legacy Restore
    await trx("files")
      .where({ id: fileId })
      .update({
        folder_id: targetFolderId,
        is_deleted: false,
        deleted_at: null,
        updated_at: new Date(),
      });

    await trx.commit();
    return {
      id: fileId,
      restored: true,
      folder_id: targetFolderId,
    };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
};

const moveFile = async (fileId, targetFolderIds, userId) => {
  const trx = await knex.transaction();
  try {
    const file = await trx("files").where({ id: fileId }).first();
    if (!file) throw new Error("File not found");

    if (!targetFolderIds || targetFolderIds.length === 0) {
      throw new Error("No target folders specified");
    }

    // Check for duplicates in ALL target folders first
    for (const folderId of targetFolderIds) {
      const existingFile = await trx("files")
        .where({
          folder_id: folderId,
          name: file.name,
          is_deleted: false,
          created_by: userId
        })
        .first();

      if (existingFile) {
        throw new Error("File already exists in directory");
      }
    }

    // 1. Move to first folder (Update original file)
    const firstFolderId = targetFolderIds[0];
    await trx("files")
      .where({ id: fileId })
      .update({
        folder_id: firstFolderId,
        updated_at: new Date(),
      });

    // 2. Copy to other folders (Insert new records pointing to same file)
    for (let i = 1; i < targetFolderIds.length; i++) {
      const folderId = targetFolderIds[i];

      await trx("files").insert({
        name: file.name,
        original_name: file.original_name,
        folder_id: folderId,
        file_path: file.file_path, // Point to same physical file
        file_url: file.file_url,
        mime_type: file.mime_type,
        size: file.size,
        created_by: userId,
        created_at: new Date(),
        updated_at: new Date(),
        is_faviourite: false, // Reset favourite for copies
        is_deleted: false,
        has_master_stamp: !!file.has_master_stamp,
        stamp_confirmed: file.stamp_confirmed !== false,
        is_archived: !!file.is_archived,
      });
    }

    await trx.commit();
    return { message: "File moved successfully" };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
};

const permanentDeleteFile = async (fileId) => {
  // Get file info before deletion
  const file = await knex("files").where({ id: fileId }).first();
  // Idempotent: folder purge / prior cron pass may have already removed it
  if (!file) {
    console.log(
      `ℹ️ [permanentDeleteFile] File ${fileId} already gone — skipping`
    );
    return { id: fileId, permanentlyDeleted: true, alreadyGone: true };
  }

  // Check if any other file uses the same path (deduplication check)
  const otherFiles = await knex("files")
    .where({ file_path: file.file_path })
    .whereNot({ id: fileId })
    .first();

  if (!otherFiles) {
    // Determine if it's an S3 file or Local file
    const path = require("path");
    const isLocalFile = file.file_path && (path.isAbsolute(file.file_path) || file.file_path.includes("uploads\\") || file.file_path.includes("uploads/"));

    if (isLocalFile) {
      // --- LOCAL DELETE ---
      if (file.file_path && fs.existsSync(file.file_path)) {
        try {
          fs.unlinkSync(file.file_path);
          console.log(`🗑️ [permanentDeleteFile] Deleted physical file: ${file.file_path}`);
        } catch (err) {
          console.error("Error deleting physical file:", err);
        }
      }
    } else {
      // --- S3 DELETE ---
      if (file.file_path) {
        try {
          console.log(`🗑️ [permanentDeleteFile] Deleting S3 Object: ${file.file_path}`);
          await deleteFileFromS3(file.file_path);
        } catch (err) {
          console.error(`❌ [permanentDeleteFile] Error deleting S3 object:`, err);
        }
      }
    }
  } else {
    console.log(
      `ℹ️ Skipping physical file deletion for ${fileId} because it is shared by other files.`
    );
  }

  // Delete file record
  await knex("files").where({ id: fileId }).del();

  return { id: fileId, permanentlyDeleted: true };
};

/**
 * Soft-archive a document (keeps it openable with OBSOLETE stamp).
 * Distinct from trash (is_deleted).
 */
const archiveFile = async (fileId) => {
  const file = await knex("files").where({ id: fileId }).first();
  if (!file) throw new Error("File not found");
  if (file.is_deleted) throw new Error("Cannot archive a deleted file");
  if (file.is_archived) return file;

  await knex("files").where({ id: fileId }).update({
    is_archived: true,
    archived_at: new Date(),
    updated_at: new Date(),
  });

  return knex("files").where({ id: fileId }).first();
};

const unarchiveFile = async (fileId) => {
  const file = await knex("files").where({ id: fileId }).first();
  if (!file) throw new Error("File not found");
  if (file.is_deleted) throw new Error("Cannot unarchive a deleted file");

  await knex("files").where({ id: fileId }).update({
    is_archived: false,
    archived_at: null,
    updated_at: new Date(),
  });

  return knex("files").where({ id: fileId }).first();
};

/**
 * List archived (non-deleted) files in a folder scope.
 * Super Admin sees all; users see own. folder_id=null → root archived files only.
 */
const getArchivedFiles = async (userId, userRole, folderId = null) => {
  const query = knex("files")
    .leftJoin("folders", "files.folder_id", "folders.id")
    .select("files.*", "folders.name as folder_name")
    .where("files.is_archived", true)
    .andWhere("files.is_deleted", false)
    .orderBy("files.archived_at", "desc");

  const role = (userRole || "").toLowerCase().trim();
  if (role !== "super_admin") {
    query.andWhere("files.created_by", userId);
  }

  if (folderId === null || folderId === undefined || folderId === "null") {
    query.whereNull("files.folder_id");
  } else {
    query.where("files.folder_id", parseInt(folderId, 10));
  }

  return query;
};

/**
 * Folders that appear in Archive for a parent.
 * Matches folderService: include fully-archived empty subfolders too.
 */
const getArchivedFoldersByParent = async (userId, userRole, parentId = null) => {
  const role = (userRole || "").toLowerCase().trim();

  let archivedQuery = knex("files")
    .where("is_archived", true)
    .andWhere("is_deleted", false)
    .whereNotNull("folder_id")
    .select("folder_id");

  if (role !== "super_admin") {
    archivedQuery = archivedQuery.andWhere("created_by", userId);
  }

  const archivedRows = await archivedQuery;
  const directFolderIds = [
    ...new Set(archivedRows.map((r) => r.folder_id).filter(Boolean)),
  ];

  if (directFolderIds.length === 0) return [];

  const allFolders = await knex("folders")
    .where("is_deleted", false)
    .select("id", "name", "parent_id", "created_by", "created_at", "updated_at");

  const byId = new Map(allFolders.map((f) => [f.id, f]));
  const relevantIds = new Set();

  for (const folderId of directFolderIds) {
    let currentId = folderId;
    while (currentId && byId.has(currentId)) {
      relevantIds.add(currentId);
      currentId = byId.get(currentId).parent_id;
    }
  }

  const fullyArchived = await getFullyArchivedFolderIds();
  for (const id of fullyArchived) {
    relevantIds.add(Number(id));
  }

  const parentKey =
    parentId === null || parentId === undefined || parentId === "null"
      ? null
      : parseInt(parentId, 10);

  if (parentKey !== null && relevantIds.has(parentKey)) {
    const parentFullyArchived = fullyArchived.has(parentKey);
    return allFolders
      .filter((folder) => {
        if (Number(folder.parent_id) !== parentKey) return false;
        if (parentFullyArchived) return true;
        return relevantIds.has(folder.id) || fullyArchived.has(folder.id);
      })
      .sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), undefined, {
          sensitivity: "base",
          numeric: true,
        })
      );
  }

  return allFolders
    .filter((folder) => {
      if (!relevantIds.has(folder.id)) return false;
      if (parentKey === null) return folder.parent_id == null;
      return Number(folder.parent_id) === parentKey;
    })
    .sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      })
    );
};

module.exports = {
  uploadFile,
  uploadFolder,
  getFile,
  getFileById,
  getUserFiles,
  updateFile,
  deleteFile,
  toggleFileFavourite,
  getFavouriteFiles,
  getTrashFiles,
  getFilesFromFolderRecursively,
  restoreFile,
  permanentDeleteFile,
  moveFile,
  archiveFile,
  unarchiveFile,
  getArchivedFiles,
  getArchivedFoldersByParent,
};
