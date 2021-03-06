/**!
 * cnpmjs.org - controllers/registry/module.js
 *
 * Copyright(c) cnpmjs.org and other contributors.
 * MIT Licensed
 *
 * Authors:
 *  dead_horse <dead_horse@qq.com> (http://deadhorse.me)
 *  fengmk2 <fengmk2@gmail.com> (http://fengmk2.github.com)
 */

'use strict';

/**
 * Module dependencies.
 */

var debug = require('debug')('cnpmjs.org:controllers:registry:module');
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var utility = require('utility');
var eventproxy = require('eventproxy');
var Bagpipe = require('bagpipe');
var urlparse = require('url').parse;
var mime = require('mime');
var semver = require('semver');
var ms = require('ms');
var config = require('../../config');
var Module = require('../../proxy/module');
var Total = require('../../proxy/total');
var nfs = require('../../common/nfs');
var common = require('../../lib/common');
var Log = require('../../proxy/module_log');
var DownloadTotal = require('../../proxy/download');
var SyncModuleWorker = require('../../proxy/sync_module_worker');
var logger = require('../../common/logger');

exports.show = function (req, res, next) {
  var name = req.params.name;
  var ep = eventproxy.create();
  ep.fail(next);

  Module.listTags(name, ep.done('tags'));
  Module.listByName(name, ep.done('rows'));

  ep.all('tags', 'rows', function (tags, rows) {
    debug('show module, user: %s, allowSync: %s, isAdmin: %s', req.session.name, req.session.allowSync, req.session.isAdmin);
    // if module not exist in this registry,
    // sync the module backend and return package info from official registry
    // TODO: Need to change this logic, it will cause unpublish sync again.
    // TODO: Hard to detect this show is on install flow or unpublish flow
    if (rows.length === 0) {
      if (!req.session.allowSync) {
        return next();
      }
      var username = (req.session && req.session.name) || 'anonymous';
      SyncModuleWorker.sync(name, username, function (err, result) {
        if (err) {
          return next(err);
        }
        if (!result.ok) {
          return res.json(result.statusCode, result.pkg);
        }
        res.json(200, result.pkg);
      });
      return;
    }

    var nextMod = null;
    var latestMod = null;
    var distTags = {};
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      distTags[t.tag] = t.version;
    }

    var versions = {};
    var times = {};
    var attachments = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.version === 'next') {
        nextMod = row;
        continue;
      }
      var pkg = row.package;
      common.setDownloadURL(pkg, req);
      pkg._cnpm_publish_time = row.publish_time;
      versions[pkg.version] = pkg;
      times[pkg.version] = row.publish_time ? new Date(row.publish_time) : row.gmt_modified;
      if ((!distTags.latest && !latestMod) || distTags.latest === row.version) {
        latestMod = row;
      }
    }

    if (!latestMod) {
      latestMod = nextMod || rows[0];
    }

    if (!nextMod) {
      nextMod = latestMod;
    }

    var rev = '';
    if (nextMod) {
      rev = String(nextMod.id);
    }

    var info = {
      _id: name,
      _rev: rev,
      name: name,
      description: latestMod.package.description,
      "dist-tags": distTags,
      maintainers: latestMod.package.maintainers,
      time: times,
      author: latestMod.package.author,
      repository: latestMod.package.repository,
      versions: versions,
      readme: latestMod.package.readme,
      _attachments: attachments,
    };

    debug('show module %s: %s, latest: %s', name, rev, latestMod.version);

    res.json(info);
  });
};

exports.get = function (req, res, next) {
  var name = req.params.name;
  var tag = req.params.version;
  var version = semver.valid(tag);
  var ep = eventproxy.create();
  ep.fail(next);

  var method = version ? 'get' : 'getByTag';
  var queryLabel = version ? version : tag;

  Module[method](name, queryLabel, ep.done(function (mod) {
    if (mod) {
      common.setDownloadURL(mod.package, req);
      mod.package._cnpm_publish_time = mod.publish_time;
      return res.json(mod.package);
    }
    ep.emit('notFound');
  }));

  ep.once('notFound', function () {
    if (!req.session.allowSync) {
      return next();
    }

    var username = (req.session && req.session.username) || 'anonymous';
    SyncModuleWorker.sync(name, username, function (err, result) {
      if (err) {
        return next(err);
      }
      var pkg = result.pkg && result.pkg.versions[version];
      if (!pkg) {
        return res.json(404, {
          error: 'not exist',
          reason: 'version not found: ' + version
        });
      }
      res.json(pkg);
    });
  });
};

var _downloads = {};

var DOWNLOAD_TIMEOUT = ms('10m');

exports.download = function (req, res, next) {
  var name = req.params.name;
  var filename = req.params.filename;
  var version = filename.slice(name.length + 1, -4);
  var ep = eventproxy.create();
  ep.fail(next);

  Module.get(name, version, ep.doneLater('moduleInfo'));
  ep.once('moduleInfo', function (row) {
    if (!row || !row.package || !row.package.dist) {
      return ep.emit('nodist');
    }
    var dist = row.package.dist;
    if (dist.key) {
      return ep.emit('key', dist);
    } else {
      return ep.emit('url', dist);
    }
    ep.emit('nodist');
  });

  ep.once('nodist', function () {
    if (!nfs.url) {
      return next();
    }
    ep.emit('url', nfs.url(common.getCDNKey(name, filename)));
  });

  ep.once('url', function (dist) {
    res.statusCode = 302;
    res.setHeader('Location', dist.tarball);
    res.end();
    _downloads[name] = (_downloads[name] || 0) + 1;
  });

  ep.once('key', function (dist) {
    if (!nfs.downloadStream && !nfs.download) {
      return next();
    }

    _downloads[name] = (_downloads[name] || 0) + 1;

    if (typeof dist.size === 'number') {
      res.setHeader('Content-Length', dist.size);
    }
    res.setHeader('Content-Type', mime.lookup(dist.key));
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('ETag', dist.shasum);

    if (nfs.downloadStream) {
      nfs.downloadStream(dist.key, res, {timeout: DOWNLOAD_TIMEOUT},
      function (err) {
        if (err) {
          // TODO: just end or send error response?
          return next(err);
        }
      });
      return;
    }

    // use download file api
    var tmpPath = path.join(config.uploadDir, utility.randomString() + dist.key);
    function cleanup() {
      fs.unlink(tmpPath, utility.noop);
    }

    nfs.download(dist.key, tmpPath, {timeout: DOWNLOAD_TIMEOUT},
    function (err) {
      if (err) {
        cleanup();
        return next(err);
      }
      var tarball = fs.createReadStream(tmpPath);
      tarball.on('error', cleanup);
      tarball.on('end', cleanup);
      tarball.pipe(res);
    });
  });
};

setInterval(function () {
  // save download count
  var totals = [];
  for (var name in _downloads) {
    var count = _downloads[name];
    totals.push([name, count]);
  }
  _downloads = {};

  if (totals.length === 0) {
    return;
  }

  debug('save download total: %j', totals);

  var date = utility.YYYYMMDD();
  var next = function () {
    var item = totals.shift();
    if (!item) {
      // done
      return;
    }

    DownloadTotal.plusTotal({name: item[0], date: date, count: item[1]}, function (err) {
      if (!err) {
        return next();
      }

      logger.error(err);
      debug('save download %j error: %s', item, err);

      totals.push(item);
      // save to _downloads
      for (var i = 0; i < totals.length; i++) {
        var v = totals[i];
        var name = v[0];
        _downloads[name] = (_downloads[name] || 0) + v[1];
      }
      // end
    });
  };
  next();
}, 5000);

exports.upload = function (req, res, next) {
  var length = Number(req.headers['content-length']) || 0;
  if (!length || req.headers['content-type'] !== 'application/octet-stream') {
    return next();
  }

  var username = req.session.name;
  var name = req.params.name;
  var id = Number(req.params.rev);
  var filename = req.params.filename;
  var version = filename.substring(name.length + 1);
  version = version.replace(/\.tgz$/, '');
  // save version on pkg upload

  debug('%s: upload %s, file size: %d', username, req.url, length);
  Module.getById(id, function (err, mod) {
    if (err || !mod) {
      return next(err);
    }
    var match = mod.package.maintainers.filter(function (item) {
      return item.name === username;
    });
    if (match.length === 0 || mod.name !== name) {
      return res.json(403, {
        error: 'no_perms',
        reason: 'Current user can not publish this module'
      });
    }

    if (mod.version !== 'next') {
      // rev wrong
      return res.json(403, {
        error: 'rev_wrong',
        reason: 'rev not match next module'
      });
    }

    var filepath = common.getTarballFilepath(filename);
    var ws = fs.createWriteStream(filepath);
    var shasum = crypto.createHash('sha1');
    req.pipe(ws);
    var dataSize = 0;
    req.on('data', function (data) {
      shasum.update(data);
      dataSize += data.length;
    });
    ws.on('finish', function () {
      if (dataSize !== length) {
        return res.json(403, {
          error: 'size_wrong',
          reason: 'Header size ' + length + ' not match download size ' + dataSize,
        });
      }
      shasum = shasum.digest('hex');

      var options = {
        key: common.getCDNKey(name, filename),
        size: length,
        shasum: shasum
      };
      nfs.upload(filepath, options, function (err, result) {
        // remove tmp file whatever
        fs.unlink(filepath, utility.noop);
        if (err) {
          return next(err);
        }

        var dist = {
          shasum: shasum,
          size: length
        };

        // if nfs upload return a key, record it
        if (result.url) {
          dist.tarball = result.url;
        } else if (result.key) {
          dist.key = result.key;
          dist.tarball = result.key;
        }

        mod.package.dist = dist;
        mod.package.version = version;
        debug('%s module: save file to %s, size: %d, sha1: %s, dist: %j, version: %s',
          id, filepath, length, shasum, dist, version);
        Module.update(mod, function (err, result) {
          if (err) {
            return next(err);
          }
          res.json(201, {ok: true, rev: String(result.id)});
        });
      });
    });
  });
};

exports.updateLatest = function (req, res, next) {
  var username = req.session.name;
  var name = req.params.name;
  var version = semver.valid(req.params.version);
  if (!version) {
    return res.json(400, {
      error: 'Params Invalid',
      reason: 'Invalid version: ' + req.params.version,
    });
  }
  Module.get(name, 'next', function (err, nextMod) {
    if (err) {
      return next(err);
    }
    if (!nextMod) {
      return next();
    }
    var match = nextMod.package.maintainers.filter(function (item) {
      return item.name === username;
    });
    if (match.length === 0) {
      return res.json(401, {
        error: 'noperms',
        reason: 'Current user can not publish this module'
      });
    }

    // check version if not match pkg upload
    if (nextMod.package.version !== version) {
      return res.json(403, {
        error: 'version_wrong',
        reason: 'version not match'
      });
    }

    var body = req.body;
    nextMod.version = version;
    nextMod.author = username;
    body.dist = nextMod.package.dist;
    body.maintainers = nextMod.package.maintainers;
    if (!body.author) {
      body.author = {
        name: username,
      };
    }
    body._publish_on_cnpm = true;
    nextMod.package = body;
    // reset publish time
    nextMod.publish_time = Date.now();
    debug('update %s:%s %j', nextMod.package.name, nextMod.package.version, nextMod.package.dist);
    // change latest to version
    Module.update(nextMod, function (err) {
      if (err) {
        debug('update nextMod %s error: %s', name, err);
        return next(err);
      }
      // set latest tag
      Module.addTag(name, 'latest', version, function (err) {
        if (err) {
          return next(err);
        }
        // add a new next version
        nextMod.version = 'next';
        Module.add(nextMod, function (err, result) {
          if (err) {
            return next(err);
          }
          res.json(201, {ok: true, rev: String(result.id)});
        });
      });
    });
  });
};

exports.addPackageAndDist = function (req, res, next) {
  // 'dist-tags': { latest: '0.0.2' },
  //  _attachments:
  // { 'nae-sandbox-0.0.2.tgz':
  //    { content_type: 'application/octet-stream',
  //      data: 'H4sIAAAAA
  //      length: 9883
  var pkg = req.body;
  var username = req.session.name;
  var name = req.params.name;
  var filename = Object.keys(pkg._attachments)[0];
  var attachment = pkg._attachments[filename];
  var version = filename.match(/\-([\.\d\w\_]+?)\.tgz$/);
  if (!version) {
    return res.json(403, {
      error: 'version_error',
      reason: filename + ' version not found',
    });
  }
  version = version[1];
  var versionPackage = pkg.versions[version];
  versionPackage._publish_on_cnpm = true;
  var distTags = pkg['dist-tags'] || {};
  var tags = []; // tag, version
  for (var t in distTags) {
    tags.push([t, distTags[t]]);
  }

  debug('addPackageAndDist %s:%s, attachment size: %s', name, version, attachment.length);

  var ep = eventproxy.create();
  ep.fail(next);
  Module.get(name, version, ep.done('exists'));

  var shasum;
  ep.on('exists', function (exists) {
    if (exists) {
      return res.json(409, {
        error: 'conflict',
        reason: 'Document update conflict.'
      });
    }

    // upload attachment
    var tarballBuffer;
    try {
      tarballBuffer = new Buffer(attachment.data, 'base64');
    } catch (e) {
      return next(e);
    }

    if (tarballBuffer.length !== attachment.length) {
      return res.json(403, {
        error: 'size_wrong',
        reason: 'Attachment size ' + attachment.length + ' not match download size ' + tarballBuffer.length,
      });
    }

    shasum = crypto.createHash('sha1');
    shasum.update(tarballBuffer);
    shasum = shasum.digest('hex');

    var options = {
      key: common.getCDNKey(name, filename),
      shasum: shasum
    };
    nfs.uploadBuffer(tarballBuffer, options, ep.done('upload'));
  });

  ep.on('upload', function (result) {
    debug('upload %j', result);

    var dist = {
      shasum: shasum,
      size: attachment.length
    };

    // if nfs upload return a key, record it
    if (result.url) {
      dist.tarball = result.url;
    } else if (result.key) {
      dist.key = result.key;
      dist.tarball = result.key;
    }

    var mod = {
      name: name,
      version: version,
      author: username,
      package: versionPackage
    };

    mod.package.dist = dist;

    Module.add(mod, ep.done(function (r) {
      debug('%s module: save file to %s, size: %d, sha1: %s, dist: %j, version: %s',
        r.id, dist.tarball, dist.size, shasum, dist, version);
      ep.emit('saveModule', r.id);
    }));
  });

  ep.on('saveModule', function () {
    if (tags.length === 0) {
      return ep.emit('saveTags');
    }

    tags.forEach(function (item) {
      Module.addTag(name, item[0], item[1], ep.done('saveTag'));
    });
    ep.after('saveTag', tags.length, function () {
      ep.emit('saveTags');
    });
  });

  ep.all('saveModule', 'saveTags', function (moduleId) {
    res.json(201, {ok: true, rev: String(moduleId)});
  });
};

exports.add = function (req, res, next) {
  var username = req.session.name;
  var name = req.params.name;
  var pkg = req.body || {};
  var maintainers = pkg.maintainers || [];
  var match = maintainers.filter(function (item) {
    return item.name === username;
  });

  debug('add module %s maintainers match: %j, current user: %s', name, match, username);

  if (match.length === 0) {
    return res.json(403, {
      error: 'no_perms',
      reason: 'Current user can not publish this module'
    });
  }

  if (pkg._attachments && Object.keys(pkg._attachments).length > 0) {
    return exports.addPackageAndDist(req, res, next);
  }

  var ep = eventproxy.create();
  ep.fail(next);

  Module.getLatest(name, ep.doneLater('latest'));
  Module.get(name, 'next', ep.done(function (nextMod) {
    if (nextMod) {
      nextMod.exists = true;
      return ep.emit('next', nextMod);
    }
    // ensure next module exits
    // because updateLatest will create next module fail
    nextMod = {
      name: name,
      version: 'next',
      author: username,
      package: {
        name: name,
        version: 'next',
        description: pkg.description,
        readme: pkg.readme,
        maintainers: pkg.maintainers,
      },
    };
    debug('add next module: %s', name);
    Module.add(nextMod, ep.done(function (result) {
      nextMod.id = result.id;
      ep.emit('next', nextMod);
    }));
  }));

  ep.all('latest', 'next', function (latestMod, nextMod) {
    var maintainers = latestMod && latestMod.package.maintainers.length > 0 ?
      latestMod.package.maintainers : nextMod.package.maintainers;
    var match = maintainers.filter(function (item) {
      return item.name === username;
    });

    if (match.length === 0) {
      return res.json(403, {
        error: 'no_perms',
        reason: 'Current user can not publish this module'
      });
    }

    debug('add %s rev: %s, version: %s', name, nextMod.id, nextMod.version);

    if (latestMod || nextMod.version !== 'next') {
      return res.json(409, {
        error: 'conflict',
        reason: 'Document update conflict.'
      });
    }

    res.json(201, {
      ok: true,
      id: name,
      rev: String(nextMod.id),
    });
  });
};

exports.removeWithVersions = function (req, res, next) {
  debug('removeWithVersions module %s, with info %j', req.params.name, req.body);
  var name = req.params.name;
  var username = req.session.name;
  var versions = req.body.versions || {};
  var ep = eventproxy.create();
  ep.fail(next);

  Module.listByName(name, ep.doneLater('list'));
  ep.once('list', function (mods) {
    if (!mods || !mods.length) {
      return next();
    }
    //TODO replace this maintainer check
    var match = mods[0].package.maintainers.filter(function (item) {
      return item.name === username;
    });

    if (!match.length || mods[0].name !== name) {
      return res.json(403, {
        error: 'no_perms',
        reason: 'Current user can not update this module'
      });
    }

    var removeVersions = [];
    for (var i = 0; i < mods.length; i++) {
      var v = mods[i].version;
      if (v !== 'next' && !versions[v]) {
        removeVersions.push(v);
      }
    }
    if (!removeVersions.length) {
      return res.json(201, {ok: true});
    }
    Module.removeByNameAndVersions(name, removeVersions, ep.done(function () {
      res.json(201, {ok: true});
    }));
  });
};


exports.removeTar = function (req, res, next) {
  debug('remove tarball with filename: %s, id: %s', req.params.filename, req.params.rev);
  var id = Number(req.params.rev);
  var filename = req.params.filename;
  var name = req.params.name;
  var username = req.session.name;
  var ep = eventproxy.create();
  ep.fail(next);

  Module.getById(id, ep.doneLater('get'));
  ep.once('get', function (mod) {
    if (!mod) {
      return next();
    }
    //TODO replace this maintainer check
    var match = mod.package.maintainers.filter(function (item) {
      return item.name === username;
    });
    if (!match.length || mod.name !== name) {
      return res.json(403, {
        error: 'no_perms',
        reason: 'Current user can not delete this tarball'
      });
    }
    var key = mod.package.dist && mod.package.dist.key;
    key = key || common.getCDNKey(mod.name, filename);

    nfs.remove(key, ep.done(function () {
      res.json(200, {ok: true});
    }));
  });
};

exports.removeAll = function (req, res, next) {
  debug('remove all the module with name: %s, id: %s', req.params.name, req.params.rev);
  var id = Number(req.params.rev);
  var name = req.params.name;
  var username = req.session.name;

  var ep = eventproxy.create();
  ep.fail(next);

  Module.listByName(name, ep.doneLater('list'));
  ep.once('list', function (mods) {
    debug('removeAll module %s: %d', name, mods.length);
    var mod = mods[0];
    if (!mod) {
      return next();
    }
    //TODO replace this maintainer check
    var match = mod.package.maintainers.filter(function (item) {
      return item.name === username;
    });
    if (req.session.isAdmin) {
      match.push({name: username});
    }

    if (!match.length || mod.name !== name) {
      return res.json(403, {
        error: 'no_perms',
        reason: 'Current user can not delete this tarball'
      });
    }
    Total.plusDeleteModule(utility.noop);
    Module.removeByName(name, ep.done('remove'));
    Module.removeTags(name, ep.done('removeTags'));
  });

  ep.all('list', 'remove', 'removeTags', function (mods) {
    var keys = [];
    for (var i = 0; i < mods.length; i++) {
      var key = urlparse(mods[i].dist_tarball).path;
      key && keys.push(key);
    }
    var queue = new Bagpipe(5);
    keys.forEach(function (key) {
      queue.push(nfs.remove.bind(nfs), key, function () {
        //ignore err here
        ep.emit('removeTar');
      });
    });
    ep.after('removeTar', keys.length, function () {
      res.json(200, {ok: true});
    });
  });
};

function parseModsForList(updated, mods, req) {
  var results = {
    _updated: updated
  };

  for (var i = 0; i < mods.length; i++) {
    var mod = mods[i];
    var pkg = {};
    try {
      pkg = JSON.parse(mod.package);
    } catch (e) {
      //ignore this pkg
      continue;
    }
    pkg['dist-tags'] = {
      latest: pkg.version
    };
    common.setDownloadURL(pkg, req);
    results[mod.name] = pkg;
  }
  return results;
}

exports.listAllModules = function (req, res, next) {
  var updated = Date.now();
  Module.listSince(0, function (err, mods) {
    if (err) {
      return next(err);
    }
    return res.json(parseModsForList(updated, mods, req));
  });
};

exports.listAllModulesSince = function (req, res, next) {
  var query = req.query || {};
  if (query.stale !== 'update_after') {
    return res.json(400, {
      error: 'query_parse_error',
      reason: 'Invalid value for `stale`.'
    });
  }
  debug('list all modules from %s', req.startkey);
  var startkey = Number(query.startkey) || 0;
  var updated = Date.now();
  Module.listSince(startkey, function (err, mods) {
    if (err) {
      return next(err);
    }
    res.json(parseModsForList(updated, mods, req));
  });
};

exports.listAllModuleNames = function (req, res, next) {
  Module.listShort(function (err, mods) {
    if (err) {
      return next(err);
    }
    var results = mods.map(function (m) {
      return m.name;
    });
    res.json(results);
  });
};
