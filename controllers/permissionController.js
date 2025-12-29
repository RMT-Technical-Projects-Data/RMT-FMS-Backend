// controllers/permissionController.js
const db = require("../config/db");

const assignPermission = async (req, res, next) => {
  try {
    const {
      user_id,
      resource_id,
      resource_type,
      can_read,
      can_download,
    } = req.body;

    // Check if user is super_admin OR owns the resource
    let isAuthorized = req.user.role === "super_admin";

    if (!isAuthorized) {
      // Check if user owns the resource
      if (resource_type === "file") {
        const file = await db("files")
          .where({ id: resource_id, created_by: req.user.id })
          .first();
        isAuthorized = !!file;
      } else if (resource_type === "folder") {
        const folder = await db("folders")
          .where({ id: resource_id, created_by: req.user.id })
          .first();
        isAuthorized = !!folder;
      }
    }

    if (!isAuthorized) {
      return res.status(403).json({
        error: "Not authorized to set permissions for this resource",
      });
    }

    // Check if permission already exists
    const existingPerm = await db("permissions")
      .where({
        user_id,
        resource_id,
        resource_type,
      })
      .first();

    let permId;

    if (existingPerm) {
      // Update existing permission
      await db("permissions").where({ id: existingPerm.id }).update({
        can_read,
        can_download,
        updated_at: new Date(),
      });
      permId = existingPerm.id;
    } else {
      // Create new permission
      [permId] = await db("permissions").insert({
        user_id,
        resource_id,
        resource_type,
        can_read,
        can_download,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    // Helper function to apply inheritance to children
    const applyInheritanceToChildren = async (parentFolderId, userId, can_read, can_download) => {
      // Get all child folders
      const childFolders = await db("folders").where({ parent_id: parentFolderId });
      console.log(`📁 Found ${childFolders.length} child folders for parent ${parentFolderId}`);

      for (const childFolder of childFolders) {
        console.log(`🔄 Processing child folder: ${childFolder.name} (ID: ${childFolder.id})`);
        // Check if permission already exists for this child folder
        const existingChildPerm = await db("permissions")
          .where({
            user_id,
            resource_id: childFolder.id,
            resource_type: "folder",
          })
          .first();

        if (existingChildPerm) {
          // Update existing permission
          console.log(`🔄 Updating existing permission for folder ${childFolder.id}`);
          await db("permissions").where({ id: existingChildPerm.id }).update({
            can_read,
            can_download,
            updated_at: new Date(),
          });
        } else if (can_read || can_download) {
          // Only create new permission if at least one permission is granted
          console.log(`➕ Creating new permission for folder ${childFolder.id}: can_read=${can_read}, can_download=${can_download}`);
          await db("permissions").insert({
            user_id,
            resource_id: childFolder.id,
            resource_type: "folder",
            can_read,
            can_download,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }

        // Recursively apply to grandchildren
        await applyInheritanceToChildren(childFolder.id, userId, can_read, can_download);
      }

      // Get all files in this folder
      const childFiles = await db("files").where({ folder_id: parentFolderId });
      console.log(`📄 Found ${childFiles.length} child files for parent ${parentFolderId}`);

      for (const childFile of childFiles) {
        console.log(`🔄 Processing child file: ${childFile.name} (ID: ${childFile.id})`);
        // Check if permission already exists for this file
        const existingFilePerm = await db("permissions")
          .where({
            user_id,
            resource_id: childFile.id,
            resource_type: "file",
          })
          .first();

        if (existingFilePerm) {
          // Update existing permission
          console.log(`🔄 Updating existing permission for file ${childFile.id}`);
          await db("permissions").where({ id: existingFilePerm.id }).update({
            can_read,
            can_download,
            updated_at: new Date(),
          });
        } else if (can_read || can_download) {
          // Only create new permission if at least one permission is granted
          console.log(`➕ Creating new permission for file ${childFile.id}: can_read=${can_read}, can_download=${can_download}`);
          await db("permissions").insert({
            user_id,
            resource_id: childFile.id,
            resource_type: "file",
            can_read,
            can_download,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
    };

    // If this is a folder, apply inheritance to all child folders and files
    if (resource_type === "folder") {
      console.log(`🌳 Applying inheritance for folder ${resource_id} to user ${user_id}`);
      await applyInheritanceToChildren(resource_id, user_id, can_read, can_download);
      console.log(`✅ Inheritance applied successfully`);
    }

    res.json({
      id: permId,
      message: "Permission assigned successfully",
    });
  } catch (err) {
    next(err);
  }
};


const getResourcePermissions = async (req, res, next) => {
  try {
    const { resource_id, resource_type } = req.query;

    const permissions = await db("permissions")
      .where({ resource_id, resource_type })
      .join("users", "permissions.user_id", "users.id")
      .select("permissions.*", "users.username", "users.role");

    res.json({ permissions });
  } catch (err) {
    next(err);
  }
};

const getUserPermissions = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const permissions = await db("permissions")
      .where({ user_id: userId })
      .select("*");

    res.json({ permissions });
  } catch (err) {
    next(err);
  }
};

const removePermission = async (req, res, next) => {
  try {
    const { permission_id } = req.body;

    // Get the permission details before deleting to know if we need to cascade
    const permission = await db("permissions").where({ id: permission_id }).first();

    if (!permission) {
      return res.status(404).json({ message: "Permission not found" });
    }

    const { user_id, resource_id, resource_type } = permission;

    // Helper function to remove inheritance from children
    const removeInheritanceFromChildren = async (parentFolderId, userId) => {
      // Get all child folders
      const childFolders = await db("folders").where({ parent_id: parentFolderId });

      for (const childFolder of childFolders) {
        // Remove permission for this child folder
        await db("permissions")
          .where({
            user_id: userId,
            resource_id: childFolder.id,
            resource_type: "folder",
          })
          .del();

        // Recursively remove from grandchildren
        await removeInheritanceFromChildren(childFolder.id, userId);
      }

      // Get all files in this folder
      const childFiles = await db("files").where({ folder_id: parentFolderId });

      for (const childFile of childFiles) {
        // Remove permission for this file
        await db("permissions")
          .where({
            user_id: userId,
            resource_id: childFile.id,
            resource_type: "file"
          })
          .del();
      }
    };

    // If it's a folder, remove permissions from all nested content
    if (resource_type === "folder") {
      await removeInheritanceFromChildren(resource_id, user_id);
    }

    // Finally delete the target permission
    await db("permissions").where({ id: permission_id }).del();

    res.json({ message: "Permission removed successfully" });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  assignPermission,
  getResourcePermissions,
  getUserPermissions,
  removePermission,
};
