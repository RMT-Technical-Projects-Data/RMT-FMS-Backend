const knex = require("../config/db");

const getClientIp = (req) => {
  if (!req) return null;
  const forwarded = req.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
};

/**
 * Record a document download for Super Admin audit review.
 */
const logDownloadActivity = async ({
  userId,
  username,
  fileId,
  documentName,
  documentStatus = "controlled",
  ipAddress = null,
}) => {
  const status =
    String(documentStatus || "controlled").toLowerCase() === "obsolete"
      ? "obsolete"
      : "controlled";

  const [id] = await knex("download_audit_logs").insert({
    user_id: userId || null,
    username: username || "Unknown",
    file_id: fileId || null,
    document_name: documentName || "Unknown",
    document_status: status,
    downloaded_at: new Date(),
    ip_address: ipAddress,
  });

  // Also write into unified activity log
  try {
    await logActivity({
      userId,
      username,
      action: "download",
      resourceType: "file",
      resourceId: fileId,
      resourceName: documentName,
      details: `Document status: ${status}`,
      ipAddress,
      status: "success",
    });
  } catch (e) {
    console.error("⚠️ activity log (download) failed:", e.message);
  }

  return knex("download_audit_logs").where({ id }).first();
};

/**
 * Unified activity audit entry.
 */
const logActivity = async ({
  userId = null,
  username = "Unknown",
  action,
  resourceType = null,
  resourceId = null,
  resourceName = null,
  details = null,
  ipAddress = null,
  status = "success",
}) => {
  if (!action) return null;

  const [id] = await knex("activity_audit_logs").insert({
    user_id: userId,
    username: username || "Unknown",
    action: String(action).slice(0, 64),
    resource_type: resourceType,
    resource_id: resourceId || null,
    resource_name: resourceName ? String(resourceName).slice(0, 512) : null,
    details: details ? String(details).slice(0, 4000) : null,
    ip_address: ipAddress,
    status: status || "success",
    created_at: new Date(),
  });

  return knex("activity_audit_logs").where({ id }).first();
};

/**
 * List download audit logs (newest first). Super Admin only at route layer.
 */
const getDownloadAuditLogs = async ({ limit = 200, offset = 0 } = {}) => {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const logs = await knex("download_audit_logs as dal")
    .leftJoin("files as f", "dal.file_id", "f.id")
    .select(
      "dal.id",
      "dal.user_id",
      "dal.username",
      "dal.file_id",
      "dal.document_name",
      "dal.downloaded_at",
      "dal.ip_address",
      knex.raw(`
        COALESCE(
          dal.document_status,
          CASE WHEN f.is_archived = 1 THEN 'obsolete' ELSE 'controlled' END
        ) as document_status
      `)
    )
    .orderBy("dal.downloaded_at", "desc")
    .limit(safeLimit)
    .offset(safeOffset);

  const [{ count }] = await knex("download_audit_logs").count({ count: "*" });

  return {
    logs,
    total: Number(count) || 0,
  };
};

/**
 * List full activity audit logs (newest first).
 */
const getActivityAuditLogs = async ({
  limit = 300,
  offset = 0,
  action = null,
  username = null,
} = {}) => {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 2000);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  let query = knex("activity_audit_logs").select("*");
  let countQuery = knex("activity_audit_logs");

  if (action) {
    query = query.where("action", action);
    countQuery = countQuery.where("action", action);
  }
  if (username) {
    query = query.where("username", "like", `%${username}%`);
    countQuery = countQuery.where("username", "like", `%${username}%`);
  }

  const logs = await query
    .orderBy("created_at", "desc")
    .limit(safeLimit)
    .offset(safeOffset);

  const [{ count }] = await countQuery.count({ count: "*" });

  return {
    logs,
    total: Number(count) || 0,
  };
};

module.exports = {
  getClientIp,
  logDownloadActivity,
  logActivity,
  getDownloadAuditLogs,
  getActivityAuditLogs,
};
