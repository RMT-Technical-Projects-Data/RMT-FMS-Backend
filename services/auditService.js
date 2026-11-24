const knex = require("../config/db");

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

  return knex("download_audit_logs").where({ id }).first();
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

module.exports = {
  logDownloadActivity,
  getDownloadAuditLogs,
};
