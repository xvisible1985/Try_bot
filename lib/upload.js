const fs = require('fs');
const path = require('path');
const multer = require('multer');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

function extensionFor(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function makeUploader(subdir, filenameFn) {
  const dir = path.join(__dirname, '..', 'uploads', subdir);
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dir),
      filename: (req, file, cb) => cb(null, filenameFn(req, file)),
    }),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME_TYPES.includes(file.mimetype)),
  });
}

module.exports = { makeUploader, extensionFor, ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES };
