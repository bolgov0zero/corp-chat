const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../auth');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'chat_db', 'chat.db');
const FILES_DIR = path.join(path.dirname(DB_PATH), 'files');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(jpeg|png|gif|webp)$/;
    cb(null, allowed.test(file.mimetype));
  },
});

// sharp опционален: без него всё работает, просто не будет миниатюр
let sharp = null;
try { sharp = require('sharp'); } catch { console.warn('[Upload] sharp не установлен — миниатюры отключены'); }

router.post('/', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не принят' });
  let thumb = null;
  // Миниатюра ~320px для ленты — полный файл грузится только в лайтбоксе.
  // GIF пропускаем, чтобы не терять анимацию в ленте.
  if (sharp && req.file.mimetype !== 'image/gif') {
    try {
      const thumbName = req.file.filename.replace(/\.[^.]*$/, '') + '_t.webp';
      await sharp(req.file.path).rotate().resize({ width: 320, withoutEnlargement: true })
        .webp({ quality: 78 }).toFile(path.join(FILES_DIR, thumbName));
      thumb = `/files/${thumbName}`;
    } catch (e) { console.warn('[Upload] thumbnail failed:', e.message); }
  }
  res.json({
    url: `/files/${req.file.filename}`,
    thumb,
    name: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype,
  });
});

module.exports = router;
