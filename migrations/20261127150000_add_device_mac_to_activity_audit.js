/**
 * Physical / MAC address for device audit trail (LAN ARP lookup).
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn("activity_audit_logs", "device_mac");
  if (!has) {
    await knex.schema.alterTable("activity_audit_logs", (table) => {
      table.string("device_mac", 64).nullable().after("device_ip");
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn("activity_audit_logs", "device_mac");
  if (has) {
    await knex.schema.alterTable("activity_audit_logs", (table) => {
      table.dropColumn("device_mac");
    });
  }
};
