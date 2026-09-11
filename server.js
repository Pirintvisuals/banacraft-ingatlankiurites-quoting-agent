import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import handler from './api/faq-agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local, then .env - a real environment variable beats both. Only this
// local dev server reads them; on Vercel the values come from the project's own
// Environment Variables.
function loadEnvFile(name) {
    let contents;
    try {
        contents = fs.readFileSync(path.join(__dirname, name), 'utf8');
    } catch (error) {
        return false;
    }
    contents.split('\n').forEach(line => {
        const eq = line.indexOf('=');
        if (eq < 1 || line.trim().startsWith('#')) return;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key && value && process.env[key] === undefined) process.env[key] = value;
    });
    return true;
}
if (!loadEnvFile('.env.local') && !loadEnvFile('.env')) {
    console.log('No .env or .env.local file found - running without AI and e-mail (buttons still work).');
}

const PORT = process.env.PORT || 8893;

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// Give Node's plain response the two helpers the Vercel handler uses.
function vercelize(res) {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
        return res;
    };
    return res;
}

const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/faq-agent')) {
        const u = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(u.searchParams.entries());
        vercelize(res);

        if (req.method !== 'POST') {
            try { await handler(req, res); } catch (error) {
                console.error('Handler error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }

        let body = '';
        let tooBig = false;
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 400_000) {
                tooBig = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ answer: 'Payload too large' }));
                req.destroy();
            }
        });
        req.on('end', async () => {
            if (tooBig) return;
            try {
                // The transcript beacon is text/plain; the handler parses strings.
                try { req.body = JSON.parse(body || '{}'); } catch (e) { req.body = body; }
                await handler(req, res);
            } catch (error) {
                console.error('Error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ answer: 'A szerver hibára futott.' }));
            }
        });
        return;
    }

    // Static files, confined to public/ so /../server.js cannot escape.
    const publicDir = path.join(__dirname, 'public');
    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = path.normalize(path.join(publicDir, reqPath === '/' ? 'index.html' : reqPath));
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<h1>403 - Forbidden</h1>');
        return;
    }
    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/html' });
            res.end(error.code === 'ENOENT' ? '<h1>404 - File Not Found</h1>' : 'Server Error');
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(content);
    });
});

server.listen(PORT, () => {
    console.log(`\nBanacraft árbecslő fut: http://localhost:${PORT}/\n`);
});
