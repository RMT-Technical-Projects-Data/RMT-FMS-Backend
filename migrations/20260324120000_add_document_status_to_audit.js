/**
 * Store document status (controlled / obsolete) on each download audit row.
 */
exports.up = async function (knex) {
  const hasCol = await knex.schema.hasColumn(
    "download_audit_logs",
    "document_status"
  );
  if (!hasCol) {
    await knex.schema.alterTable("download_audit_logs", (table) => {
      table.string("document_status", 32).nullable().defaultTo(null);
    });
  }

  // Backfill from current file archive flag where possible
  await knex.raw(`
    UPDATE download_audit_logs dal
    LEFT JOIN files f ON f.id = dal.file_id
    SET dal.document_status = CASE
      WHEN f.id IS NULL THEN COALESCE(dal.document_status, 'controlled')
      WHEN f.is_archived = 1 THEN 'obsolete'
      ELSE 'controlled'
    END
    WHERE dal.document_status IS NULL
  `);
};

exports.down = async function (knex) {
  const hasCol = await knex.schema.hasColumn(
    "download_audit_logs",
    "document_status"
  );
  if (hasCol) {
    await knex.schema.alterTable("download_audit_logs", (table) => {
      table.dropColumn("document_status");
    });
  }
};
