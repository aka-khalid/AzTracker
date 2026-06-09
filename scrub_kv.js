const https = require('https');

function fetchScrub(cursor) {
    return new Promise((resolve, reject) => {
        const url = `https://aztracker-v2.khalid-ibrahim-dev.workers.dev/api/scrub-history-temp${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}: ${data}`));
                resolve(JSON.parse(data));
            });
        }).on('error', reject);
    });
}

async function run() {
    console.log("Starting remote paginated scrub...");
    let cursor = null;
    let totalScrubbed = 0;
    let pages = 0;
    try {
        do {
            pages++;
            process.stdout.write(`Fetching page ${pages}... `);
            const result = await fetchScrub(cursor);
            console.log(`Scrubbed ${result.scrubbedCount} on this page.`);
            totalScrubbed += result.scrubbedCount;
            cursor = result.nextCursor;
        } while (cursor);
        console.log(`\nSuccess! Scrubbed ${totalScrubbed} products total across ${pages} pages.`);
    } catch (e) {
        console.error("Error:", e.message);
    }
}

run();
