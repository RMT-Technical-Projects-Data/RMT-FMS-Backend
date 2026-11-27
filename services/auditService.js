const os = require("os");
const { execSync } = require("child_process");
const knex = require("../config/db");

let cachedLanIp = null;
let cachedLanIpAt = 0;
let cachedHasDeviceIpCol = null;
let cachedHasDeviceMacCol = null;
const macCache = new Map(); // ip -> { mac, at }

const hasDeviceIpColumn = async () => {
  if (cachedHasDeviceIpCol != null) return cachedHasDeviceIpCol;
  try {
    cachedHasDeviceIpCol = await knex.schema.hasColumn(
      "activity_audit_logs",
      "device_ip"
    );
  } catch {
    cachedHasDeviceIpCol = false;
  }
  return cachedHasDeviceIpCol;
};

const hasDeviceMacColumn = async () => {
  if (cachedHasDeviceMacCol != null) return cachedHasDeviceMacCol;
  try {
    cachedHasDeviceMacCol = await knex.schema.hasColumn(
      "activity_audit_logs",
      "device_mac"
    );
  } catch {
    cachedHasDeviceMacCol = false;
  }
  return cachedHasDeviceMacCol;
};

const normalizeMac = (raw) => {
  if (!raw) return null;
  const cleaned = String(raw)
    .trim()
    .replace(/-/g, ":")
    .toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(cleaned)) return null;
  // Ignore empty / broadcast-ish
  if (cleaned === "00:00:00:00:00:00" || cleaned === "FF:FF:FF:FF:FF:FF") {
    return null;
  }
  return cleaned;
};

/**
 * Resolve physical (MAC) address for a LAN IP via ARP / neighbor table.
 * Works when the client is on the same network as the server.
 */
const getMacForIp = (ip) => {
  const target = normalizeIp(ip);
  if (!target || isLoopbackIp(target)) return null;

  const cached = macCache.get(target);
  if (cached && Date.now() - cached.at < 60_000) return cached.mac;

  // If IP belongs to this machine, read MAC from OS interfaces
  try {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets || {})) {
      if (!entries) continue;
      for (const entry of entries) {
        if (entry?.address === target && entry.mac) {
          const localMac = normalizeMac(entry.mac);
          if (localMac) {
            macCache.set(target, { mac: localMac, at: Date.now() });
            return localMac;
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  let mac = null;
  try {
    if (process.platform === "win32") {
      const out = execSync(`arp -a ${target}`, {
        encoding: "utf8",
        timeout: 2500,
        windowsHide: true,
      });
      // Match line that contains the IP, then MAC like aa-bb-cc-dd-ee-ff
      const lines = out.split(/\r?\n/);
      for (const line of lines) {
        if (!line.includes(target)) continue;
        const m = line.match(/([0-9a-f]{2}[-:]){5}[0-9a-f]{2}/i);
        if (m) {
          mac = normalizeMac(m[0]);
          break;
        }
      }
    } else {
      let out = "";
      try {
        out = execSync(`ip neigh show ${target}`, {
          encoding: "utf8",
          timeout: 2500,
        });
      } catch {
        out = execSync(`arp -n ${target}`, {
          encoding: "utf8",
          timeout: 2500,
        });
      }
      const m = out.match(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
      mac = normalizeMac(m ? m[0] : null);
    }
  } catch (e) {
    console.warn(`⚠️ ARP lookup failed for ${target}:`, e.message);
  }

  macCache.set(target, { mac, at: Date.now() });
  return mac;
};

const isLoopbackIp = (ip) => {
  if (!ip) return true;
  const normalized = String(ip).replace(/^::ffff:/i, "").trim();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "localhost"
  );
};

/**
 * Prefer a private LAN IPv4 (e.g. 192.168.x.x) so local audit logs show the PC IP
 * instead of 127.0.0.1 when the browser hits localhost.
 */
const getMachineLanIp = () => {
  const now = Date.now();
  if (cachedLanIp && now - cachedLanIpAt < 60_000) return cachedLanIp;

  const nets = os.networkInterfaces();
  const candidates = [];

  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry || entry.internal) continue;
      const family = entry.family;
      const isV4 = family === "IPv4" || family === 4;
      if (!isV4 || !entry.address) continue;
      candidates.push(entry.address);
    }
  }

  const preferred =
    candidates.find((ip) => ip.startsWith("192.168.")) ||
    candidates.find((ip) => ip.startsWith("10.")) ||
    candidates.find((ip) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) ||
    candidates[0] ||
    null;

  cachedLanIp = preferred;
  cachedLanIpAt = now;
  return preferred;
};

const normalizeIp = (raw) => {
  if (!raw) return null;
  let ip = String(raw).trim();
  if (!ip) return null;
  if (ip.toLowerCase().startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.split(":")[0];
  }
  return ip;
};

/** Connection / Wi‑Fi network IP as seen by the server */
const getClientIp = (req) => {
  if (!req) return getMachineLanIp();

  const forwarded = req.headers?.["x-forwarded-for"];
  let ip = null;
  if (typeof forwarded === "string" && forwarded.length) {
    ip = normalizeIp(forwarded.split(",")[0]);
  }
  if (!ip) {
    ip = normalizeIp(
      req.ip ||
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        null
    );
  }

  if (!ip || isLoopbackIp(ip)) {
    return getMachineLanIp() || ip || "127.0.0.1";
  }

  return ip;
};

/** Client-reported device/LAN IP (from browser WebRTC via header) */
const getDeviceIp = (req) => {
  if (!req) return null;
  const raw =
    req.headers?.["x-client-device-ip"] ||
    req.headers?.["x-device-ip"] ||
    null;
  const ip = normalizeIp(raw);
  if (!ip || isLoopbackIp(ip)) return null;
  // Basic IPv4 sanity
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  return ip;
};

/** Client-reported or server-resolved physical / MAC address */
const getDeviceMac = (req, fallbackIp = null) => {
  if (!req && !fallbackIp) return null;
  const headerMac = normalizeMac(
    req?.headers?.["x-client-device-mac"] ||
      req?.headers?.["x-device-mac"] ||
      null
  );
  if (headerMac) return headerMac;

  const deviceIp = getDeviceIp(req);
  const networkIp = fallbackIp || getClientIp(req);
  return getMacForIp(deviceIp) || getMacForIp(networkIp);
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
  deviceIp = null,
  deviceMac = null,
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
      deviceIp,
      deviceMac,
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
  deviceIp = null,
  deviceMac = null,
  status = "success",
}) => {
  if (!action) return null;

  const row = {
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
  };

  if (await hasDeviceIpColumn()) {
    row.device_ip = deviceIp || null;
  }
  if (await hasDeviceMacColumn()) {
    row.device_mac = deviceMac || null;
  }

  const [id] = await knex("activity_audit_logs").insert(row);
  return knex("activity_audit_logs").where({ id }).first();
};

/** Convenience: log from an Express request */
const auditFromReq = async (
  req,
  {
    action,
    resourceType = null,
    resourceId = null,
    resourceName = null,
    details = null,
    status = "success",
    userId = null,
    username = null,
  }
) => {
  try {
    const ipAddress = getClientIp(req);
    const deviceIp = getDeviceIp(req) || ipAddress;
    const deviceMac = getDeviceMac(req, deviceIp || ipAddress);
    return await logActivity({
      userId: userId ?? req.user?.id ?? null,
      username:
        username ||
        req.user?.username ||
        req.body?.username ||
        "Unknown",
      action,
      resourceType,
      resourceId,
      resourceName,
      details,
      ipAddress,
      deviceIp,
      deviceMac,
      status,
    });
  } catch (e) {
    console.error(`⚠️ audit (${action}) failed:`, e.message);
    return null;
  }
};

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
  const lanIp = getMachineLanIp();

  return {
    logs: logs.map((row) => ({
      ...row,
      ip_address: displayAuditIp(row.ip_address, lanIp),
      server_ip: lanIp,
    })),
    total: Number(count) || 0,
  };
};

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
  const lanIp = getMachineLanIp();
  const hasDeviceCol = await hasDeviceIpColumn();
  const hasMacCol = await hasDeviceMacColumn();

  return {
    logs: logs.map((row) => {
      const deviceIp = hasDeviceCol ? normalizeIp(row.device_ip) : null;
      const deviceMac = hasMacCol ? normalizeMac(row.device_mac) : null;
      return {
        ...row,
        ip_address: displayAuditIp(row.ip_address, lanIp),
        device_ip: deviceIp,
        device_mac: deviceMac,
        // Prefer IP; fall back to physical address when IP is missing
        device_display: deviceIp || deviceMac || null,
        server_ip: lanIp,
      };
    }),
    total: Number(count) || 0,
    server_ip: lanIp,
  };
};

/** Show LAN IP for loopback/null so local audit UI is readable */
const displayAuditIp = (storedIp, lanIp = getMachineLanIp()) => {
  const normalized = normalizeIp(storedIp);
  if (!normalized || isLoopbackIp(normalized)) {
    return lanIp || normalized || "—";
  }
  return normalized;
};

module.exports = {
  getClientIp,
  getDeviceIp,
  getDeviceMac,
  getMacForIp,
  getMachineLanIp,
  logDownloadActivity,
  logActivity,
  auditFromReq,
  getDownloadAuditLogs,
  getActivityAuditLogs,
};
