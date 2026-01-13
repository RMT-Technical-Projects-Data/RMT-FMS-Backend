const { Upload } = require("@aws-sdk/lib-storage");
const { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const { s3Client, BUCKET_NAME } = require("../config/s3Config");

/**
 * Upload a file to S3
 * @param {string} filePath - Local path to the file
 * @param {string} key - S3 object key
 * @param {string} mimeType - MIME type of the file
 * @returns {Promise<object>} - S3 upload result
 */
const uploadFileToS3 = async (filePath, key, mimeType) => {
    try {
        const fileStream = fs.createReadStream(filePath);

        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: BUCKET_NAME,
                Key: key,
                Body: fileStream,
                ContentType: mimeType,
            },
        });

        console.log(`🚀 [S3] Starting upload to ${key}`);
        const result = await upload.done();
        console.log(`✅ [S3] Upload complete: ${result.Location}`);
        return result;
    } catch (err) {
        console.error(`❌ [S3] Upload error:`, err);
        throw err;
    }
};

/**
 * Delete a file from S3
 * @param {string} key - S3 object key
 */
const deleteFileFromS3 = async (key) => {
    try {
        const command = new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });
        await s3Client.send(command);
        console.log(`🗑️ [S3] Deleted object: ${key}`);
    } catch (err) {
        console.error(`❌ [S3] Delete error:`, err);
        throw err;
    }
};

/**
 * Get a file stream from S3 for downloading/streaming
 * @param {string} key - S3 object key
 * @returns {Promise<ReadableStream>}
 */
const getFileStreamFromS3 = async (key) => {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });
        const response = await s3Client.send(command);
        return response.Body;
    } catch (err) {
        console.error(`❌ [S3] Get Stream error:`, err);
        throw err;
    }
};

/**
 * Check if a file exists in S3
 * @param {string} key 
 * @returns {Promise<boolean>}
 */
const checkFileExistsInS3 = async (key) => {
    try {
        const command = new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        await s3Client.send(command);
        return true;
    } catch (error) {
        if (error.name === 'NotFound') return false;
        throw error;
    }
}

/**
 * Copy a file in S3
 * @param {string} sourceKey - Source S3 object key
 * @param {string} destinationKey - Destination S3 object key
 * @returns {Promise<void>}
 */
const copyFileInS3 = async (sourceKey, destinationKey) => {
    try {
        const command = new CopyObjectCommand({
            Bucket: BUCKET_NAME,
            CopySource: `${BUCKET_NAME}/${sourceKey}`, // Format: Bucket/Key
            Key: destinationKey,
        });
        await s3Client.send(command);
        console.log(`©️ [S3] Copied object from ${sourceKey} to ${destinationKey}`);
    } catch (err) {
        console.error(`❌ [S3] Copy error:`, err);
        throw err;
    }
};

module.exports = {
    uploadFileToS3,
    deleteFileFromS3,
    getFileStreamFromS3,
    checkFileExistsInS3,
    copyFileInS3
};
