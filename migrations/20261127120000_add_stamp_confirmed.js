/**
 * Files stay off the dashboard until the upload stamp preference is chosen.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn("files", "stamp_confirmed");
  if (!has) {
    await knex.schema.alterTable("files", (table) => {
      table.boolean("stamp_confirmed").notNullable().defaultTo(false);
    });
  }
  // Existing files are already visible — mark them confirmed
  await knex("files").update({ stamp_confirmed: true });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn("files", "stamp_confirmed");
  if (has) {
    await knex.schema.alterTable("files", (table) => {
      table.dropColumn("stamp_confirmed");
    });
  }
};
