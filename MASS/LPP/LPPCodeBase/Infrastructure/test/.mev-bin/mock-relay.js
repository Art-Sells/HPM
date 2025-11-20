
    const http = require('http');
    const crypto = require('crypto');
    
    const server = http.createServer((req, res) => {
      const ok = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      const notFound = () => {
        res.writeHead(404);
        res.end();
      };

      if (req.method === 'GET' && req.url === '/eth/v1/builder/status') {
        ok({ status: 'ok' });
        return;
      }

      if (req.method === 'POST' && req.url === '/eth/v1/builder/blinded_blocks') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          ok({
            status: 'accepted',
            bundleHash: '0x' + crypto.randomBytes(32).toString('hex'),
          });
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/mev_sendBundle') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          ok({
            jsonrpc: '2.0',
            id: 1,
            result: {
              bundleHash: '0x' + crypto.randomBytes(32).toString('hex'),
              status: 'ok',
            },
          });
        });
        return;
      }

      notFound();
    });
    
    server.listen(18551, () => {
      console.log('Mock relay listening on port 18551');
    });
  