// Load .env file at module-import time, BEFORE any other module that reads
// process.env (especially db-sqlite.ts which opens the DB at module load).
//
// This file must be imported FIRST in server-express.ts. ES modules evaluate
// imports in order, so a side-effect import here populates process.env
// before route imports trigger the database initialization.

import path from 'path';
import fs from 'fs';

// __dirname here is dist-server/lib at runtime; .env lives at dist-server/.env
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.substring(0, idx).trim();
    const value = line.substring(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
