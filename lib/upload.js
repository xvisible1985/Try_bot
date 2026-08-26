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
      // filenameFn may throw (or return a falsy value) to reject the
      // upload BEFORE anything is written to disk — critical for any
      // uploader whose filename is derived from request-controlled input
      // (e.g. weapon_key), since multer's disk storage joins this value
      // onto `dir` with plain path.join, which does not confine `..`
      // segments to `dir`. Validating only AFTER this callback returns
      // is too late — the file would already be written, possibly
      // outside `dir` entirely. filenameFn implementations must validate
      // against a fixed allowlist before returning a name, not merely
      // sanitize/escape it.
      filename: (req, file, cb) => {
        let name;
        try {
          name = filenameFn(req, file);
        } catch (err) {
          return cb(err);
        }
        if (!name) return cb(new Error('rejected: filenameFn returned no name'));
        cb(null, name);
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME_TYPES.includes(file.mimetype)),
  });
}

module.exports = { makeUploader, extensionFor, ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES };
