'use strict';

const fs = require('fs');
const path = require('path');

function serveStatic(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const mount = (options.mountPath || '/').replace(/\/$/, '') || '';
  const indexFile = options.index || 'index.html';

  return function staticMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    if (mount && !(req.path === mount || req.path.startsWith(mount + '/'))) {
      return next();
    }

    let relative = mount ? req.path.slice(mount.length) : req.path;
    if (relative === '' || relative === '/') relative = '/' + indexFile;

    // Decode, then resolve against root and verify containment.
    let decoded;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      return res.status(400).send('Bad Request');
    }


    if (decoded.includes('\0')) {
      return res.status(400).json({ error: 'Bad Request', reason: 'null byte in path' });
    }

    const target = path.resolve(root, '.' + path.posix.normalize(decoded));
    if (target !== root && !target.startsWith(root + path.sep)) {
      return res.status(403).json({ error: 'Forbidden', reason: 'path traversal blocked' });
    }



    const serveContained = (file, after) => {
      fs.realpath(file, (rpErr, real) => {
        if (rpErr) return next();
        if (real !== root && !real.startsWith(root + path.sep)) {
          return res.status(403).json({ error: 'Forbidden', reason: 'symlink escapes root' });
        }
        res.sendFile(real, after);
      });
    };

    fs.stat(target, (err, stats) => {
      if (err) return next();
      if (stats.isDirectory()) {
        const indexPath = path.join(target, indexFile);
        return fs.stat(indexPath, (e2, s2) => {
          if (e2 || !s2.isFile()) return next();
          serveContained(indexPath, () => next());
        });
      }
      if (!stats.isFile()) return next();
      serveContained(target, () => next());
    });
  };
}

module.exports = serveStatic;
