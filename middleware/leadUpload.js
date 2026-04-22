/**
 * Lead Upload Middleware — multer config for CSV import only.
 * All other file uploads go through the external File Upload Microservice.
 */
import multer from 'multer';

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.mimetype === 'application/csv' || file.originalname.endsWith('.csv')) {
      return cb(null, true);
    }
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only CSV files are accepted for import'));
  },
});

const handleUploadErrors = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
};

export { csvUpload, handleUploadErrors };
