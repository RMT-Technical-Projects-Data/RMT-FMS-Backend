const path = require("path");
const fs = require("fs");
const { getFileBufferFromS3, getFileStreamFromS3 } = require("../services/s3Service");

const isLocalFilePath = (filePath) =>
  !!filePath &&
  (path.isAbsolute(filePath) ||
    filePath.includes("uploads\\") ||
    filePath.includes("uploads/"));

/**
 * Resolve a legacy local uploads path against common candidates.
 */
const resolveLocalFilePath = (storedPath) => {
  if (!storedPath) return null;

  const candidates = [
    storedPath,
    path.resolve(process.cwd(), storedPath),
  ];

  const normalized = storedPath.replace(/\\/g, "/");
  const uploadIndex = normalized.indexOf("uploads/");

  if (uploadIndex !== -1) {
    const suffix = normalized.substring(uploadIndex);
    candidates.push(path.join(process.cwd(), suffix));
    candidates.push(path.join(__dirname, "..", suffix));
  } else {
    candidates.push(path.join(process.cwd(), "uploads", storedPath));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

/**
 * Load file bytes from S3 or local storage.
 * @param {{ file_path: string }} file
 * @returns {Promise<Buffer>}
 */
const getFileBuffer = async (file) => {
  if (!file?.file_path) {
    throw new Error("File path not found");
  }

  if (!isLocalFilePath(file.file_path)) {
    return getFileBufferFromS3(file.file_path);
  }

  const localPath = resolveLocalFilePath(file.file_path);
  if (!localPath) {
    throw new Error("File not found on server");
  }

  return fs.promises.readFile(localPath);
};

/**
 * Get a readable stream for non-PDF passthrough responses.
 */
const getFileReadable = async (file) => {
  if (!file?.file_path) {
    throw new Error("File path not found");
  }

  if (!isLocalFilePath(file.file_path)) {
    return getFileStreamFromS3(file.file_path);
  }

  const localPath = resolveLocalFilePath(file.file_path);
  if (!localPath) {
    throw new Error("File not found on server");
  }

  return fs.createReadStream(localPath);
};

module.exports = {
  isLocalFilePath,
  resolveLocalFilePath,
  getFileBuffer,
  getFileReadable,
};
