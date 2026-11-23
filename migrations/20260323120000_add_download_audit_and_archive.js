/**
 * Download audit logs + archive status for document control.
 */
exports.up = async function (knex) {
  const hasAuditTable = await knex.schema.hasTable("download_audit_logs");
  if (!hasAuditTable) {
    await knex.schema.createTable("download_audit_logs", (table) => {
      table.increments("id").primary();
      table
        .integer("user_id")
        .unsigned()
        .references("id")
        .inTable("users")
        .onDelete("SET NULL")
        .nullable();
      table.string("username").notNullable();
      table
        .integer("file_id")
        .unsigned()
        .references("id")
        .inTable("files")
        .onDelete("SET NULL")
        .nullable();
      table.string("document_name").notNullable();
      table.timestamp("downloaded_at").notNullable().defaultTo(knex.fn.now());
      table.string("ip_address").nullable();
      table.index(["downloaded_at"]);
      table.index(["user_id"]);
      table.index(["file_id"]);
    });
  }

  const hasIsArchived = await knex.schema.hasColumn("files", "is_archived");
  if (!hasIsArchived) {
    await knex.schema.alterTable("files", (table) => {
      table.boolean("is_archived").notNullable().defaultTo(false);
      table.timestamp("archived_at").nullable();
    });
  }
};

exports.down = async function (knex) {
  const hasIsArchived = await knex.schema.hasColumn("files", "is_archived");
  if (hasIsArchived) {
    await knex.schema.alterTable("files", (table) => {
      table.dropColumn("archived_at");
      table.dropColumn("is_archived");
    });
  }

  await knex.schema.dropTableIfExists("download_audit_logs");
};
