const handle = require('../../../lib/handler');
module.exports = (req, res) => handle(req, res, req.query.code, req.query.action);
