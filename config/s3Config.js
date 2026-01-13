// config/s3Config.js
require("dotenv").config();
const { S3Client } = require("@aws-sdk/client-s3");

const s3Config = {
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    bucketName: process.env.AWS_BUCKET_NAME,
};

const s3Client = new S3Client({
    region: s3Config.region,
    credentials: s3Config.credentials,
});

module.exports = { s3Client, BUCKET_NAME: s3Config.bucketName };
