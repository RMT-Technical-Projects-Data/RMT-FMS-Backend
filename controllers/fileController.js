// controllers/fileController.js
const knex = require("../config/db");
const path = require("path"); // Add this if missing
const fs = require("fs"); // Add this if missing
const mime = require("mime-types");

const {
  uploadFile,
  uploadFolder,
  getFile,
  getUserFiles,
  updateFile,
  deleteFile,
  getFileById,
  toggleFileFavourite,
  getFavouriteFiles,
  getTrashFiles,
  restoreFile,
  permanentDeleteFile,
} = require("../services/fileService");
const uploadFiles = async (req, res, next) => {
  try {
    const { folder_id } = req.body;
    const userId = req.user.id;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }
    const trx = await knex.transaction();
    try {
      const uploaded = [];
      for (const file of req.files) {
        const fileUrl = `/api/files/${file.filename}/download`;
        const [fileId] = await trx("files").insert({
          name: file.originalname,
          original_name: file.originalname,
          folder_id: folder_id || null,
          file_path: file.path,
          file_url: fileUrl,
          mime_type: file.mimetype,
          size: file.size,
          created_by: userId,
          created_at: new Date(),
          updated_at: new Date(),
        });
        uploaded.push({
          id: fileId,
          name: file.originalname,
          url: `/api/files/${fileId}/download`,
          size: file.size,
          mime_type: file.mimetype,
        });
      }
      await trx.commit();
      res.json({ message: "Files uploaded successfully", files: uploaded });
    } catch (err) {
      await trx.rollback();
      console.error("DB insert error:", err);
      req.files.forEach((file) => {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      });
      throw err;
    }
  } catch (err) {
    console.error("Upload error:", err);
    next(err);
  }
};
async function ensureFolderStructure(folderParts, createdBy, parentId = null) {
  let currentParentId = parentId;

  for (const folderName of folderParts) {
    if (!folderName || folderName.trim() === "") continue;

    // Check if this folder already exists under current parent
    let existingFolder = await knex("folders")
      .where({
        name: folderName,
        parent_id: currentParentId,
        created_by: createdBy,
      })
      .first();

    if (!existingFolder) {
      // Create new folder
      const [newFolderId] = await knex("folders").insert({
        name: folderName,
        parent_id: currentParentId,
        created_by: createdBy,
        created_at: new Date(),
        updated_at: new Date(),
        is_faviourite: false,
        is_deleted: false,
      });

      existingFolder = { id: newFolderId };
      console.log(
        `📁 [Folder DB] Created folder: ${folderName} (ID: ${newFolderId}) under parent: ${currentParentId}`
      );
    } else {
      console.log(
        `📁 [Folder DB] Folder already exists: ${folderName} (ID: ${existingFolder.id})`
      );
    }

    currentParentId = existingFolder.id;
  }

  return currentParentId;
}
const uploadFolderWithFiles = async (req, res) => {
  console.log("📂 [Upload Folder] Starting folder upload processing");

  try {
    const userId = req.user?.id;
    const files = req.files;
    const body = req.body;

    console.log("📂 [Upload Folder] Request details:", {
      userId,
      fileCount: files ? files.length : 0,
      hasFiles: !!files,
    });

    const allPaths = body.allPaths ? JSON.parse(body.allPaths) : [];
    const paths = body.paths || [];
    const uploadType = body.uploadType;
    const parentFolderId = body.folderId ? parseInt(body.folderId) : null;

    console.log("📂 [Upload Folder] Folder structure:", {
      allPathsCount: allPaths.length,
      allPaths: allPaths,
      uploadType,
      parentFolderId,
    });

    // Convert paths to array if it's a string
    const pathsArray = Array.isArray(paths) ? paths : [paths];

    const uploadedFiles = []; // Array to collect uploaded file info

    // 🟢 Step 1: Create ALL folder structures in DB and filesystem
    console.log("🟢 [Upload Folder] Creating complete folder structure...");

    if (allPaths.length > 0) {
      for (const folderPath of allPaths) {
        const folderParts = folderPath.split("/").filter(Boolean);
        if (folderParts.length === 0) continue;

        console.log(`📁 [Upload Folder] Ensuring folder: ${folderPath}`);

        // Create folder in database
        const folderId = await ensureFolderStructure(
          folderParts,
          userId,
          parentFolderId
        );

        // Create physical folder in filesystem
        const localDir = path.join("uploads", ...folderParts);
        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
          console.log(
            `✅ [Upload Folder] Created physical folder: ${localDir}`
          );
        } else {
          console.log(`ℹ️ [Upload Folder] Folder already exists: ${localDir}`);
        }
      }
    } else {
      console.log("ℹ️ [Upload Folder] No folder paths to create");
    }

    // 🟢 Step 2: Process each file
    if (files && files.length > 0) {
      console.log(`🟢 [Upload Folder] Processing ${files.length} files...`);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relativePath = pathsArray[i] || file.originalname;

        console.log(`📄 [Upload Folder] Processing file ${i + 1}:`, {
          originalName: file.originalname,
          relativePath: relativePath,
          size: file.size,
        });

        const parts = relativePath.split("/").filter(Boolean);
        const fileName = parts.pop();
        const folderParts = parts;

        let folderId = parentFolderId;

        // Ensure folders exist and get the final folder ID (redundant but safe)
        if (folderParts.length > 0) {
          folderId = await ensureFolderStructure(
            folderParts,
            userId,
            parentFolderId
          );
        }

        // Build correct save path
        const localDir = path.join("uploads", ...folderParts);
        const finalPath = path.join(localDir, fileName);

        // Ensure directory exists (should already exist from step 1)
        if (!fs.existsSync(localDir)) {
          console.log(
            `⚠️ [Upload Folder] Folder missing, creating: ${localDir}`
          );
          fs.mkdirSync(localDir, { recursive: true });
        }

        // Move file from temp to final location
        fs.renameSync(file.path, finalPath);

        // Save file metadata to DB and get the inserted file
        const [insertedFile] = await knex("files")
          .insert({
            name: fileName,
            folder_id: folderId,
            file_path: finalPath,
            file_url: `/uploads/${path.join(...folderParts, fileName)}`,
            created_by: userId,
            created_at: new Date(),
            updated_at: new Date(),
            mime_type: file.mimetype,
            size: file.size,
            original_name: file.originalname,
            is_faviourite: false,
            is_deleted: false,
          })
          .returning("*");

        uploadedFiles.push(insertedFile);
        console.log(`✅ [Upload Folder] Saved file: ${finalPath}`);
      }
    } else {
      console.log(
        "ℹ️ [Upload Folder] No files to process - creating empty folder structure only"
      );
    }

    // 🟢 Step 3: Return the expected response structure
    console.log("🔍 [Upload Folder] Upload completed. Summary:");
    console.log(`   - Folders created in DB: ${allPaths.length}`);
    console.log(`   - Files processed: ${uploadedFiles.length}`);

    // Return the structure that frontend expects
    res.status(200).json({
      files: uploadedFiles, // This is what the frontend expects
      message: `✅ ${
        uploadType === "folder" ? "Folder" : "Files"
      } uploaded successfully!`,
      fileCount: uploadedFiles.length,
      folderCount: allPaths.length,
    });
  } catch (err) {
    console.error("❌ [Upload Folder] Error:", err);

    // Clean up: Remove any uploaded files on error
    if (req.files) {
      req.files.forEach((file) => {
        try {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch (cleanupErr) {
          console.error("Error cleaning up file:", cleanupErr);
        }
      });
    }

    res.status(500).json({
      message: "Server error during upload",
      error: err.message,
    });
  }
};
const downloadFile = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const userId = req.user.id;
    const userRole = req.user.role;

    console.log(
      `📥 [downloadFile] Download request - File ID: ${fileId}, User ID: ${userId}, Role: ${userRole}`
    );

    req.resourceType = "file";
    req.resourceId = fileId;
    req.action = "download";

    const file = await getFileById(fileId);
    console.log(
      `📥 [downloadFile] File from DB:`,
      file
        ? {
            id: file.id,
            name: file.name,
            created_by: file.created_by,
            file_path: file.file_path,
            is_deleted: file.is_deleted,
          }
        : "NOT FOUND"
    );

    if (!file) {
      console.log(
        `❌ [downloadFile] File not found in database - ID: ${fileId}`
      );
      return res.status(404).json({ error: "File not found" });
    }

    // Check if file is deleted
    if (file.is_deleted) {
      console.log(`❌ [downloadFile] File is deleted - ID: ${fileId}`);
      return res.status(404).json({ error: "File not found" });
    }

    // Check if user owns the file or is super admin
    // if (file.created_by !== userId && userRole !== "super_admin") {
    //   console.log(`❌ [downloadFile] User ${userId} does not own file ${fileId} (owner: ${file.created_by})`);
    //   return res.status(403).json({ error: "Permission denied" });
    // }

    // Check if file exists in local storage
    if (!file.file_path) {
      console.log(`❌ [downloadFile] File path is null - ID: ${fileId}`);
      return res.status(404).json({ error: "File path not found" });
    }

    if (!require("fs").existsSync(file.file_path)) {
      console.log(
        `❌ [downloadFile] File does not exist on server - Path: ${file.file_path}`
      );
      return res.status(404).json({ error: "File not found on server" });
    }

    console.log(
      `✅ [downloadFile] File found, streaming - Path: ${file.file_path}`
    );

    // Set appropriate headers for download
    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);

    // Stream the file
    const fileStream = require("fs").createReadStream(file.file_path);
    fileStream.pipe(res);
  } catch (err) {
    console.error("❌ [downloadFile] Error:", err);
    next(err);
  }
};
const openFile = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const userId = req.user.id;
    const userRole = req.user.role;

    console.log(
      `🟢 [openFile] Open request - File ID: ${fileId}, User ID: ${userId}, Role: ${userRole}`
    );

    req.resourceType = "file";
    req.resourceId = fileId;
    req.action = "open";

    const file = await getFileById(fileId);

    console.log(
      `🟢 [openFile] File from DB:`,
      file
        ? {
            id: file.id,
            name: file.name,
            created_by: file.created_by,
            file_path: file.file_path,
            is_deleted: file.is_deleted,
          }
        : "NOT FOUND"
    );

    if (!file) {
      console.log(`❌ [openFile] File not found in DB - ID: ${fileId}`);
      return res.status(404).json({ error: "File not found" });
    }

    if (file.is_deleted) {
      console.log(`❌ [openFile] File is deleted - ID: ${fileId}`);
      return res.status(404).json({ error: "File not found" });
    }

    if (!file.file_path || !fs.existsSync(file.file_path)) {
      console.log(
        `❌ [openFile] File missing on server - Path: ${file.file_path}`
      );
      return res.status(404).json({ error: "File not found on server" });
    }

    const mimeType =
      file.mime_type ||
      mime.lookup(file.file_path) ||
      "application/octet-stream";

    console.log(`✅ [openFile] Streaming file inline - MIME: ${mimeType}`);

    // ✅ Set headers for viewing inline (not download)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${file.name}"`);

    const fileStream = fs.createReadStream(file.file_path);
    fileStream.pipe(res);
  } catch (err) {
    console.error("❌ [openFile] Error:", err);
    next(err);
  }
};
// ✅ Fixed getFiles
const getFiles = async (req, res, next) => {
  console.log("into the get files");

  try {
    const { folder_id, context } = req.query;
    const userId = req.user.id;

    console.log(
      `🔍 getFiles called - folder_id: ${folder_id}, user_id: ${userId}, context: ${context}`
    );

    let userFiles = [];

    if (context === "favourites") {
      // === FAVOURITES CONTEXT ===
      if (folder_id) {
        // Get files from this folder that the user has favourited
        userFiles = await knex("files")
          .join(
            "user_favourite_files",
            "files.id",
            "=",
            "user_favourite_files.file_id"
          )
          .where("user_favourite_files.user_id", userId)
          .andWhere("files.folder_id", folder_id)
          .andWhere("files.is_deleted", false)
          .select("files.*")
          .orderBy("user_favourite_files.created_at", "desc");
        console.log(
          `✅ Favourited files in folder ${folder_id}: ${userFiles.length}`
        );
      } else {
        // Get all favourited files (root favourites)
        userFiles = await knex("files")
          .join(
            "user_favourite_files",
            "files.id",
            "=",
            "user_favourite_files.file_id"
          )
          .leftJoin("folders", "files.folder_id", "folders.id")
          .select("files.*", "folders.name as folder_name")
          .where("user_favourite_files.user_id", userId)
          .andWhere("files.is_deleted", false)
          .orderBy("user_favourite_files.created_at", "desc");
      }
    } else {
      // === DEFAULT DASHBOARD CONTEXT ===
      userFiles = await getUserFiles(userId, folder_id);

      // Include files user has permission to access
      const permissionQuery = knex("files")
        .join("permissions", function () {
          this.on("files.id", "=", "permissions.resource_id").andOn(
            "permissions.resource_type",
            "=",
            knex.raw("'file'")
          );
        })
        .where("permissions.user_id", userId)
        .where("permissions.can_read", true)
        .andWhere("files.is_deleted", false);

      if (folder_id) {
        permissionQuery.where("files.folder_id", folder_id);
      }

      const permissionFiles = await permissionQuery.select("files.*");

      // Deduplicate
      const existingIds = new Set(userFiles.map((f) => f.id));
      for (const file of permissionFiles) {
        if (!existingIds.has(file.id)) {
          userFiles.push(file);
        }
      }
    }

    console.log(`✅ Total files returned: ${userFiles.length}`);
    res.json({ files: userFiles });
  } catch (err) {
    console.error("Error in getFiles:", err);
    next(err);
  }
};

const updateFileDetails = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const { name } = req.body;

    req.resourceType = "file";
    req.resourceId = fileId;
    req.action = "edit";

    const updatedFile = await updateFile(fileId, { name });
    res.json(updatedFile);
  } catch (err) {
    console.error("Error in updateFileDetails:", err);
    next(err);
  }
};

const deleteFileById = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);

    req.resourceType = "file";
    req.resourceId = fileId;
    req.action = "delete";

    await deleteFile(fileId);
    res.json({ message: "File deleted successfully" });
  } catch (err) {
    console.error("Error in deleteFileById:", err);
    next(err);
  }
};

const toggleFileFavouriteController = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const userId = req.user.id; // ensure your authMiddleware sets req.user

    const result = await toggleFileFavourite(fileId, userId);
    res.json(result);
  } catch (err) {
    console.error("Error in toggleFileFavouriteController:", err);
    next(err);
  }
};

const getFavouriteFilesController = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const files = await getFavouriteFiles(userId);
    res.json({ files });
  } catch (err) {
    console.error("Error in getFavouriteFilesController:", err);
    next(err);
  }
};

const getTrashFilesController = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const folderId = req.query.folder_id ? parseInt(req.query.folder_id) : null;
    const files = await getTrashFiles(userId, folderId);
    res.json({ files });
  } catch (err) {
    console.error("Error in getTrashFilesController:", err);
    next(err);
  }
};

const restoreFileController = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const result = await restoreFile(fileId);
    res.json(result);
  } catch (err) {
    console.error("Error in restoreFileController:", err);
    next(err);
  }
};

const permanentDeleteFileController = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const result = await permanentDeleteFile(fileId);
    res.json(result);
  } catch (err) {
    console.error("Error in permanentDeleteFileController:", err);
    next(err);
  }
};

module.exports = {
  uploadFolderWithFiles,
  downloadFile,
  getFiles,
  updateFileDetails,
  deleteFileById,
  uploadFiles,
  toggleFileFavouriteController,
  getFavouriteFilesController,
  getTrashFilesController,
  restoreFileController,
  permanentDeleteFileController,
  openFile,
};
