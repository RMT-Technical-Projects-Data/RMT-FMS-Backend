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
  moveFile,
  archiveFile,
  unarchiveFile,
  getArchivedFiles,
  getArchivedFoldersByParent,
} = require("../services/fileService");
const { getFileStreamFromS3, uploadFileToS3 } = require("../services/s3Service");
const {
  logDownloadActivity,
  getDownloadAuditLogs,
  getActivityAuditLogs,
  logActivity,
  getClientIp,
} = require("../services/auditService");
const { isPdfFile, applyPdfStamps } = require("../services/pdfStampService");
const { getFileBuffer, getFileReadable } = require("../utils/fileContentHelper");


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
      const errors = []; // Initialize errors array

      for (const file of req.files) {
        try {
          // Use the service layer (which uses S3)
          // Note: uploadFile takes (file, folderId, userId)
          const result = await uploadFile(file, folder_id, userId);
          uploaded.push(result);
        } catch (fileError) {
          console.error(`❌ [Bulk Upload] Error uploading file ${file.originalname}:`, fileError);
          errors.push({
            filename: file.originalname,
            error: fileError.message
          });
        }
      }
      await trx.commit();

      console.log(`✅ [Bulk Upload] Successfully uploaded ${uploaded.length} files`);
      if (errors.length > 0) {
        console.warn(`⚠️ [Bulk Upload] ${errors.length} files failed to upload`);
      }

      res.json({
        message: "Files processed",
        files: uploaded,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (err) {
      await trx.rollback();
      console.error("DB insert error:", err);
      // cleanup handled by service mostly, but if we crashed here, Multer files might be left
      req.files.forEach((file) => {
        if (fs.existsSync(file.path)) {
          try { fs.unlinkSync(file.path); } catch (e) { }
        }
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
      .andWhere("is_deleted", false) // Ignore trash folders
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
        // Create folder in database
        // Start S3 Refactor: We still need DB folders, but not physical ones.
        // However, function ensures DB folder exists.
        const folderId = await ensureFolderStructure(
          folderParts,
          userId,
          parentFolderId
        );

        // Remove physical folder creation for S3
        // Logical folder structure is sufficient.
        console.log(`✅ [Upload Folder] Ensured DB folder: ${folderPath} (ID: ${folderId})`);
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

        const normalizedRelativePath = relativePath.replace(/\\/g, "/");
        const parts = normalizedRelativePath.split("/").filter(Boolean);
        const fileName = parts.pop();
        const folderParts = parts;

        let folderId = parentFolderId;

        // Ensure folders exist and get the final folder ID
        if (folderParts.length > 0) {
          folderId = await ensureFolderStructure(
            folderParts,
            userId,
            parentFolderId
          );
        }

        // --- DUPLICATE CHECK & RENAME START ---
        let finalName = fileName;
        let checkName = fileName;
        let counter = 1;
        let duplicateExists = true;

        while (duplicateExists) {
          const existingFile = await knex("files")
            .where({
              name: checkName,
              folder_id: folderId, // Use the resolved folderId
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
        finalName = checkName;
        // --- DUPLICATE CHECK & RENAME END ---

        // --- S3 UPLOAD START ---
        // Construct S3 Key: UserUploads/{userId}/{relativePath}
        // relativePath includes the full folder structure + filename.
        // But we want to ensure we use the *renamed* filename if there was a duplicate.
        // So we reconstruct the path using folderParts + finalName.

        const keyParts = [...folderParts, finalName];
        // If relativePath started with folders, they are in folderParts.
        // If we want a specific root for user, e.g. "UserUploads/UserID/..."
        const s3Key = `UserUploads/${userId}/${keyParts.join("/")}`;

        console.log(`🚀 [Upload Folder] Uploading to S3: ${s3Key}`);

        await uploadFileToS3(file.path, s3Key, file.mimetype);

        // Remove temp file
        if (fs.existsSync(file.path)) {
          try {
            fs.unlinkSync(file.path);
          } catch (e) { console.warn("Failed to delete temp file", e); }
        }
        // --- S3 UPLOAD END ---

        const fileUrl = `/api/files/${encodeURIComponent(finalName)}/download`;

        // Save file metadata to DB and get the inserted file
        const [insertedFile] = await knex("files")
          .insert({
            name: finalName,
            folder_id: folderId,
            file_path: s3Key, // Store S3 Key
            file_url: fileUrl, // API download URL
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
        console.log(`✅ [Upload Folder] Saved file info: ${finalName}`);
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
      message: `✅ ${uploadType === "folder" ? "Folder" : "Files"
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
    const username = req.user.username || "Unknown";
    const downloadedAt = new Date();

    console.log(
      `📥 [downloadFile] Download request - File ID: ${fileId}, User ID: ${userId}, Role: ${userRole}`
    );

    req.resourceType = "file";
    req.resourceId = fileId;
    req.action = "download";

    const file = await getFileById(fileId);

    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    // Deleted files are not downloadable; archived files remain downloadable (stamped)
    if (file.is_deleted) {
      return res.status(404).json({ error: "File not found" });
    }

    if (!file.file_path) {
      return res.status(404).json({ error: "File path not found" });
    }

    // Audit log — who downloaded what, when, and document status (stamp type)
    try {
      await logDownloadActivity({
        userId,
        username,
        fileId: file.id,
        documentName: file.name,
        documentStatus: file.is_archived ? "obsolete" : "controlled",
        ipAddress: getClientIp(req),
      });
    } catch (auditErr) {
      console.error("⚠️ [downloadFile] Audit log failed:", auditErr.message);
    }

    const contentType = file.mime_type || "application/octet-stream";
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);

    // stamp query: "1"/"true" → apply stamps; "0"/"false" → original file
    const stampRaw = String(req.query.stamp ?? "1").toLowerCase();
    const withStamp = !(stampRaw === "0" || stampRaw === "false" || stampRaw === "no");

    // Download stamps (only when requested):
    // - archived → OBSOLETE (top-center)
    // - active → MASTER COPY (top-center) + CONTROLLED COPY (bottom-center)
    if (withStamp && isPdfFile(file)) {
      try {
        let pdfBuffer = await getFileBuffer(file);
        if (file.is_archived) {
          pdfBuffer = await applyPdfStamps(pdfBuffer, { obsolete: true });
        } else {
          pdfBuffer = await applyPdfStamps(pdfBuffer, {
            master: true,
            controlled: true,
          });
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Length", pdfBuffer.length);
        return res.send(pdfBuffer);
      } catch (stampErr) {
        console.error("❌ [downloadFile] PDF stamp failed, falling back:", stampErr);
      }
    }

    // Non-PDF (or stamp fallback): stream original bytes
    try {
      const readable = await getFileReadable(file);
      res.setHeader("Content-Type", contentType);
      readable.pipe(res);
    } catch (streamErr) {
      console.error("❌ [downloadFile] Stream error:", streamErr);
      return res.status(404).json({ error: "File not found in storage" });
    }
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

    // Determine if it's an S3 file or Local file
    // Heuristic: If it has "uploads\" or is absolute path, it is likely local (Legacy)
    // New S3 keys are "UserUploads/..."
    const isLocalFile =
      file.file_path &&
      (path.isAbsolute(file.file_path) ||
        file.file_path.includes("uploads\\") ||
        file.file_path.includes("uploads/"));

    if (!isLocalFile) {
      // --- S3 OPEN (STREAMING) ---
      console.log(`🟢 [openFile] Streaming from S3: ${file.file_path}`);
      try {
        const s3Stream = await getFileStreamFromS3(file.file_path);

        const mimeType = file.mime_type || "application/octet-stream";

        // ✅ Set headers for viewing inline
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
        res.setHeader("Content-Type", mimeType);
        res.setHeader("Content-Disposition", `inline; filename="${file.name}"`);

        s3Stream.pipe(res);
      } catch (s3Error) {
        console.error(`❌ [openFile] S3 Stream Error:`, s3Error);
        return res
          .status(404)
          .json({ error: "File not found in cloud storage" });
      }
    } else {
      // --- LOCAL OPEN (LEGACY) ---
      // Robust path resolution strategy (Standardized)
      let filePath = null;
      const candidates = [];

      if (file.file_path) {
        candidates.push(file.file_path);
        candidates.push(path.resolve(process.cwd(), file.file_path));

        const normalized = file.file_path.replace(/\\/g, "/");
        const uploadIndex = normalized.indexOf("uploads/");

        if (uploadIndex !== -1) {
          const suffix = normalized.substring(uploadIndex);
          candidates.push(path.join(process.cwd(), suffix));
          candidates.push(path.join(__dirname, "..", suffix));
        } else {
          candidates.push(path.join(process.cwd(), "uploads", file.file_path));
        }
      }

      for (const p of candidates) {
        if (fs.existsSync(p)) {
          filePath = p;
          break;
        }
      }

      if (!filePath) {
        console.error(
          `❌ [openFile] File not found. Checked candidates:`,
          candidates
        );
        return res.status(404).json({ error: "File not found on server" });
      }

      if (!filePath || !fs.existsSync(filePath)) {
        console.log(
          `❌ [openFile] File missing on server - Path: ${file.file_path}`
        );
        return res.status(404).json({ error: "File not found on server" });
      }

      const mimeType =
        file.mime_type ||
        mime.lookup(filePath) ||
        "application/octet-stream";

      console.log(`✅ [openFile] Streaming file inline - MIME: ${mimeType}`);

      // ✅ Set headers for viewing inline (not download)
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `inline; filename="${file.name}"`);

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
    }
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
          .andWhere("files.is_archived", false)
          .andWhere("files.stamp_confirmed", true)
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
          .andWhere("files.is_archived", false)
          .andWhere("files.stamp_confirmed", true)
          .orderBy("user_favourite_files.created_at", "desc");
      }
    } else {
      // === DEFAULT DASHBOARD CONTEXT ===
      const userRole = req.user.role ? req.user.role.toLowerCase().trim() : "";

      if (userRole === 'super_admin') {
        let query = knex("files")
          .where("is_deleted", false)
          .andWhere("is_archived", false)
          .andWhere("stamp_confirmed", true);

        if (folder_id && folder_id !== "null" && folder_id !== "undefined") {
          query.where("folder_id", folder_id);
        } else {
          query.whereNull("folder_id");
        }
        userFiles = await query.select("*").orderBy("created_at", "desc");
      } else {
        userFiles = await getUserFiles(userId, folder_id);
      }

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
        .andWhere("files.is_deleted", false)
        .andWhere("files.is_archived", false)
        .andWhere("files.stamp_confirmed", true);

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
    const { name, created_at, has_master_stamp } = req.body;
    const userRole = (req.user.role || "").toLowerCase().trim();

    req.resourceType = "file";
    req.resourceId = fileId;
    req.action = "edit";

    const updates = {};

    if (typeof name === "string" && name.trim()) {
      updates.name = name.trim();
    }

    if (typeof has_master_stamp === "boolean") {
      updates.has_master_stamp = has_master_stamp;
    }

    // Upload date editing is Super Admin only — never expose to regular users
    if (created_at !== undefined) {
      if (userRole !== "super_admin") {
        return res.status(403).json({
          error: "Only Super Admin can edit the document upload date",
        });
      }

      const parsed = new Date(created_at);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "Invalid upload date" });
      }
      updates.created_at = parsed;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const updatedFile = await updateFile(fileId, updates);
    res.json(updatedFile);
  } catch (err) {
    console.error("Error in updateFileDetails:", err);
    next(err);
  }
};

const setMasterStampBatchController = async (req, res, next) => {
  try {
    const { fileIds, has_master_stamp } = req.body;
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ error: "fileIds required" });
    }
    if (typeof has_master_stamp !== "boolean") {
      return res.status(400).json({ error: "has_master_stamp boolean required" });
    }

    await knex("files")
      .whereIn(
        "id",
        fileIds.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n))
      )
      .update({
        has_master_stamp,
        stamp_confirmed: true,
        updated_at: new Date(),
      });

    const files = await knex("files").whereIn("id", fileIds);
    res.json({ message: "Stamp preference saved", files });
  } catch (err) {
    console.error("Error in setMasterStampBatchController:", err);
    next(err);
  }
};

const getDownloadAuditLogsController = async (req, res, next) => {
  try {
    const role = (req.user.role || "").toLowerCase().trim();
    if (role !== "super_admin") {
      return res.status(403).json({ error: "Super Admin access required" });
    }

    const { limit, offset } = req.query;
    const result = await getDownloadAuditLogs({ limit, offset });
    res.json(result);
  } catch (err) {
    console.error("Error in getDownloadAuditLogsController:", err);
    next(err);
  }
};

const getActivityAuditLogsController = async (req, res, next) => {
  try {
    const role = (req.user.role || "").toLowerCase().trim();
    if (role !== "super_admin") {
      return res.status(403).json({ error: "Super Admin access required" });
    }

    const { limit, offset, action, username } = req.query;
    const result = await getActivityAuditLogs({
      limit,
      offset,
      action: action || null,
      username: username || null,
    });
    res.json(result);
  } catch (err) {
    console.error("Error in getActivityAuditLogsController:", err);
    next(err);
  }
};

const archiveFileController = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const file = await archiveFile(fileId);
    res.json({ message: "File archived successfully", file });
  } catch (err) {
    if (err.message === "File not found") {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === "Cannot archive a deleted file") {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

const unarchiveFileController = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const file = await unarchiveFile(fileId);
    res.json({ message: "File restored from archive", file });
  } catch (err) {
    if (err.message === "File not found") {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
};

const getArchivedFilesController = async (req, res, next) => {
  try {
    const folderId =
      req.query.folder_id !== undefined &&
      req.query.folder_id !== null &&
      req.query.folder_id !== "" &&
      req.query.folder_id !== "null"
        ? parseInt(req.query.folder_id, 10)
        : null;
    const files = await getArchivedFiles(req.user.id, req.user.role, folderId);
    res.json({ files });
  } catch (err) {
    console.error("Error in getArchivedFilesController:", err);
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

const deleteFileById = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);

    req.resourceType = "file";
    req.resourceId = fileId;
    req.action = "delete";

    const existing = await knex("files").where({ id: fileId }).first();
    await deleteFile(fileId);

    try {
      await logActivity({
        userId: req.user?.id,
        username: req.user?.username,
        action: "delete_file",
        resourceType: "file",
        resourceId: fileId,
        resourceName: existing?.name || `file:${fileId}`,
        details: "Moved to trash",
        ipAddress: getClientIp(req),
      });
    } catch (_) {}

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
    if (err.message === "File already exists") {
      return res.status(409).json({
        message:
          "Restore failed: a file with this name already exists in the destination.",
      });
    }
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

const moveFileController = async (req, res, next) => {
  try {
    const fileId = parseInt(req.params.id);
    const { targetFolderIds } = req.body;
    const userId = req.user.id;

    // Call the service
    const result = await moveFile(fileId, targetFolderIds, userId);
    res.json(result);

  } catch (err) {
    // ✅ Check specifically for the "File not found" error thrown by your service
    if (err.message === "File not found") {
      console.warn(`⚠️ Move failed: File ${req.params.id} does not exist.`);
      return res.status(404).json({ error: "This file no longer exists. Please refresh the page." });
    }

    if (err.message === "File already exists in directory") {
      console.warn(`⚠️ Move failed: Duplicate file in target directory.`);
      return res.status(409).json({ message: "File already exists in directory" });
    }

    // For all other errors, pass to the global error handler
    next(err);
  }
};

/**
 * Global search across files + folders the user can access.
 * GET /files/search?q=
 */
const searchFilesAndFolders = async (req, res, next) => {
  try {
    const raw = (req.query.q || "").toString().trim();
    if (!raw) {
      return res.json({ files: [], folders: [] });
    }

    // Limit length; strip LIKE wildcards from user input
    const term = raw.slice(0, 100).replace(/[%_]/g, "");
    if (!term) {
      return res.json({ files: [], folders: [] });
    }
    const like = `%${term}%`;
    const userId = req.user.id;
    const userRole = (req.user.role || "").toLowerCase().trim();
    const isSuperAdmin = userRole === "super_admin";

    let filesQuery = knex("files")
      .leftJoin("folders", "files.folder_id", "folders.id")
      .select("files.*", "folders.name as folder_name")
      .where("files.is_deleted", false)
      .andWhere("files.is_archived", false)
      .andWhere("files.stamp_confirmed", true)
      .andWhere(function () {
        this.where("files.name", "like", like).orWhere(
          "files.original_name",
          "like",
          like
        );
      })
      .orderBy("files.name", "asc")
      .limit(100);

    let foldersQuery = knex("folders")
      .select("folders.*")
      .where("folders.is_deleted", false)
      .andWhere("folders.name", "like", like)
      .orderBy("folders.name", "asc")
      .limit(100);

    if (!isSuperAdmin) {
      filesQuery = filesQuery.andWhere(function () {
        this.where("files.created_by", userId)
          .orWhereExists(function () {
            this.select(knex.raw("1"))
              .from("permissions")
              .whereRaw("permissions.resource_id = files.id")
              .andWhere("permissions.resource_type", "file")
              .andWhere("permissions.user_id", userId)
              .andWhere("permissions.can_read", true);
          })
          .orWhereExists(function () {
            this.select(knex.raw("1"))
              .from("permissions")
              .whereRaw("permissions.resource_id = files.folder_id")
              .andWhere("permissions.resource_type", "folder")
              .andWhere("permissions.user_id", userId)
              .andWhere("permissions.can_read", true);
          });
      });

      foldersQuery = foldersQuery.andWhere(function () {
        this.where("folders.created_by", userId).orWhereExists(function () {
          this.select(knex.raw("1"))
            .from("permissions")
            .whereRaw("permissions.resource_id = folders.id")
            .andWhere("permissions.resource_type", "folder")
            .andWhere("permissions.user_id", userId)
            .andWhere("permissions.can_read", true);
        });
      });
    }

    const [files, folders] = await Promise.all([filesQuery, foldersQuery]);
    res.json({ files, folders });
  } catch (err) {
    console.error("Error in searchFilesAndFolders:", err);
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
  getDownloadAuditLogsController,
  getActivityAuditLogsController,
  setMasterStampBatchController,
  archiveFileController,
  unarchiveFileController,
  getArchivedFilesController,
  getArchivedFoldersController,
  openFile,
  moveFileController,
  searchFilesAndFolders,
};
