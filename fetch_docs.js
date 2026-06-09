const https = require('https');
const fs = require('fs');

const options = {
    hostname: 'affiliate-program.amazon.com',
    path: '/creatorsapi/docs/en-us/api-reference/operations/get-items',
    method: 'GET',
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
};

const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        fs.writeFileSync('docs.html', data);
        console.log('Saved to docs.html');
    });
});

req.on('error', (e) => {
    console.error(e);
});
req.end();
