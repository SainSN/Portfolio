const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'portfolio.json');

function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnv();

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;

function readPortfolio() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 600_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const pair = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
}

function isAdmin(req) {
  const token = getCookie(req, 'tahir_session');
  const expires = sessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function checkOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  try {
    if (new URL(origin).host === host) return true;
  } catch { /* reject malformed origin below */ }
  sendJson(res, 403, { error: 'Request origin is not allowed.' });
  return false;
}

function cleanText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safePortfolio(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid portfolio data.');
  const old = readPortfolio();
  const profile = input.profile || {};
  const contacts = input.contacts || {};
  const inputTranslations = profile.translations || {};
  const skills = Array.isArray(input.skills) ? input.skills.slice(0, 24) : [];
  const projects = Array.isArray(input.projects) ? input.projects.slice(0, 30) : [];
  const cleanLink = value => {
    const link = cleanText(value, 500);
    if (!link) return '';
    if (/^(https?:\/\/|mailto:|tel:)/i.test(link)) return link;
    throw new Error('Links must start with https://, http://, mailto:, or tel:.');
  };

  const translatedProfile = {};
  for (const locale of ['ru', 'az', 'tr']) {
    const supplied = inputTranslations[locale] || {};
    const previous = old.profile.translations?.[locale] || {};
    translatedProfile[locale] = {
      role: cleanText(supplied.role ?? previous.role, 80),
      experience: cleanText(supplied.experience ?? previous.experience, 40),
      availability: cleanText(supplied.availability ?? previous.availability, 80),
      headline: cleanText(supplied.headline ?? previous.headline, 180),
      summary: cleanText(supplied.summary ?? previous.summary, 400),
      about: cleanText(supplied.about ?? previous.about, 2400)
    };
  }

  return {
    profile: {
      firstName: cleanText(profile.firstName, 60) || old.profile.firstName,
      lastName: cleanText(profile.lastName, 80),
      country: cleanText(profile.country, 80),
      experience: cleanText(profile.experience, 40),
      role: cleanText(profile.role, 80),
      headline: cleanText(profile.headline, 180),
      summary: cleanText(profile.summary, 400),
      about: cleanText(profile.about, 2400),
      availability: cleanText(profile.availability, 80),
      translations: translatedProfile
    },
    skills: skills.map(skill => ({ name: cleanText(skill?.name, 48), group: cleanText(skill?.group, 48) })).filter(skill => skill.name),
    contacts: {
      telegram: cleanLink(contacts.telegram),
      email: cleanText(contacts.email, 160),
      github: cleanLink(contacts.github),
      linkedin: cleanLink(contacts.linkedin)
    },
    projects: projects.map((project, index) => ({
      id: cleanText(project?.id, 64) || crypto.randomUUID(),
      title: cleanText(project?.title, 100),
      description: cleanText(project?.description, 500),
      stack: cleanText(project?.stack, 180),
      category: cleanText(project?.category, 60),
      link: cleanLink(project?.link),
      featured: Boolean(project?.featured),
      translations: Object.fromEntries(['ru', 'az', 'tr'].map(locale => [locale, {
        description: cleanText(project?.translations?.[locale]?.description, 500)
      }])),
      order: index
    })).filter(project => project.title)
  };
}

function serveStatic(req, res, pathname) {
  const routeAliases = { '/': 'index.html', '/about': 'index.html', '/admin': 'index.html' };
  const requested = routeAliases[pathname] || pathname.replace(/^\//, '');
  const absolute = path.resolve(PUBLIC_DIR, requested);
  if (!absolute.startsWith(PUBLIC_DIR + path.sep) && absolute !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const ext = path.extname(absolute);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: https:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  });
  fs.createReadStream(absolute).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && pathname === '/api/portfolio') {
      sendJson(res, 200, readPortfolio());
      return;
    }

    if (pathname.startsWith('/api/admin/')) {
      if (req.method !== 'GET' && !checkOrigin(req, res)) return;

      if (pathname === '/api/admin/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || 'unknown';
        const attempts = (loginAttempts.get(ip) || []).filter(time => time > Date.now() - 15 * 60 * 1000);
        if (attempts.length >= 8) {
          sendJson(res, 429, { error: 'Too many attempts. Please try again in a few minutes.' });
          return;
        }
        const body = await readBody(req, 10_000);
        const username = String(body.username || '');
        const password = String(body.password || '');
        const equal = (a, b) => {
          const left = Buffer.from(a);
          const right = Buffer.from(b);
          return left.length === right.length && crypto.timingSafeEqual(left, right);
        };
        if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !equal(username, ADMIN_USERNAME) || !equal(password, ADMIN_PASSWORD)) {
          attempts.push(Date.now());
          loginAttempts.set(ip, attempts);
          sendJson(res, 401, { error: 'The username or password is incorrect.' });
          return;
        }
        loginAttempts.delete(ip);
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, Date.now() + SESSION_TTL);
        sendJson(res, 200, { ok: true, portfolio: readPortfolio() }, {
          'Set-Cookie': `tahir_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${req.socket.encrypted ? '; Secure' : ''}`
        });
        return;
      }

      if (pathname === '/api/admin/session' && req.method === 'GET') {
        if (!isAdmin(req)) { sendJson(res, 401, { error: 'Authentication required.' }); return; }
        sendJson(res, 200, { ok: true, portfolio: readPortfolio() });
        return;
      }

      if (pathname === '/api/admin/portfolio' && req.method === 'PUT') {
        if (!isAdmin(req)) { sendJson(res, 401, { error: 'Authentication required.' }); return; }
        const body = await readBody(req);
        const portfolio = safePortfolio(body);
        fs.writeFileSync(DATA_FILE, `${JSON.stringify(portfolio, null, 2)}\n`, 'utf8');
        sendJson(res, 200, { ok: true, portfolio });
        return;
      }

      if (pathname === '/api/admin/logout' && req.method === 'POST') {
        sessions.delete(getCookie(req, 'tahir_session'));
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'tahir_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        return;
      }
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 400, { error: error.message || 'Something went wrong.' });
    else res.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Portfolio ready at http://localhost:${PORT}`);
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) console.warn('Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment or .env before using /admin.');
});
