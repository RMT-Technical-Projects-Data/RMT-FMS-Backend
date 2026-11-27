/**
 * Store client device/LAN IP separately from connection (network) IP.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn("activity_audit_logs", "device_ip");
  if (!has) {
    await knex.schema.alterTable("activity_audit_logs", (table) => {
      table.string("device_ip", 255).nullable().after("ip_address");
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn("activity_audit_logs", "device_ip");
  if (has) {
    await knex.schema.alterTable("activity_audit_logs", (table) => {
      table.dropColumn("device_ip");
    });
  }
};
