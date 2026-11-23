exports.up = async function (knex) {
  const has = await knex.schema.hasColumn("files", "has_master_stamp");
  if (!has) {
    await knex.schema.alterTable("files", (table) => {
      table.boolean("has_master_stamp").notNullable().defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn("files", "has_master_stamp");
  if (has) {
    await knex.schema.alterTable("files", (table) => {
      table.dropColumn("has_master_stamp");
    });
  }
};
