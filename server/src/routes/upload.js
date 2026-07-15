const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../auth');
const db = require('../db');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'chat_db', 'chat.db');
const FILES_DIR = path.join(path.dirname(DB_PATH), 'files');

function getSetting(key, def) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? def;
}

function getUploadSettings() {
  return {
    image: {
      maxSizeMb: parseInt(getSetting('upload_image_max_size', '10')),
      extensions: getSetting('upload_image_extensions', 'jpeg,jpg,png,gif,webp')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    },
    file: {
      maxSizeMb: parseInt(getSetting('upload_file_max_size', '50')),
      extensions: getSetting('upload_file_extensions', '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    },
  };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

// Permissive limit — real limits are validated after upload
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

function startCleanupJob() {
  const run = () => {
    const lifetimeDays = parseInt(getSetting('upload_file_lifetime', '0'));
    if (!lifetimeDays) return;
    const cutoffMs = Date.now() - lifetimeDays * 86_400_000;
    try {
      for (const filename of fs.readdirSync(FILES_DIR)) {
        const filePath = path.join(FILES_DIR, filename);
        try {
          if (fs.statSync(filePath).mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            console.log('[Cleanup] Удалён устаревший файл:', filename);
          }
        } catch {}
      }
    } catch (e) { console.warn('[Cleanup] Ошибка:', e.message); }
  };
  run();
  setInterval(run, 6 * 3_600_000);
}

// sharp опционален: без него всё работает, просто не будет миниатюр
let sharp = null;
try { sharp = require('sharp'); } catch { console.warn('[Upload] sharp не установлен — миниатюры отключены'); }

router.get('/settings', authMiddleware, (req, res) => {
  res.json(getUploadSettings());
});

router.post('/', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не принят' });

  const settings = getUploadSettings();
  const isImage = req.file.mimetype.startsWith('image/');
  const cfg = isImage ? settings.image : settings.file;
  const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();

  if (req.file.size > cfg.maxSizeMb * 1024 * 1024) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Файл превышает лимит ${cfg.maxSizeMb} МБ` });
  }

  if (cfg.extensions.length > 0 && !cfg.extensions.includes(ext)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Расширение .${ext} не разрешено` });
  }

  let thumb = null;
  if (isImage && sharp && req.file.mimetype !== 'image/gif') {
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
module.exports.startCleanupJob = startCleanupJob;
