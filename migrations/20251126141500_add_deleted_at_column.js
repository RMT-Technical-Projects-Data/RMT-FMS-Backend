exports.up = function (knex) {
    return Promise.all([
        knex.schema.alterTable("files", function (table) {
            table.timestamp("deleted_at").nullable();
        }),
        knex.schema.alterTable("folders", function (table) {
            table.timestamp("deleted_at").nullable();
        }),
    ]);
};

exports.down = function (knex) {
    return Promise.all([
        knex.schema.alterTable("files", function (table) {
            table.dropColumn("deleted_at");
        }),
        knex.schema.alterTable("folders", function (table) {
            table.dropColumn("deleted_at");
        }),
    ]);
};
