/**
 * Full activity audit trail: login, deletes, downloads, uploads, etc.
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasTable("activity_audit_logs");
  if (exists) return;

  await knex.schema.createTable("activity_audit_logs", (table) => {
    table.increments("id").primary();
    table.integer("user_id").unsigned().nullable().index();
    table.string("username", 255).notNullable().index();
    table.string("action", 64).notNullable().index();
    table.string("resource_type", 32).nullable();
    table.integer("resource_id").nullable();
    table.string("resource_name", 512).nullable();
    table.text("details").nullable();
    table.string("ip_address", 255).nullable();
    table.string("status", 32).notNullable().defaultTo("success");
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now()).index();
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("activity_audit_logs");
};
