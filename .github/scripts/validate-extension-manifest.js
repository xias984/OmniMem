const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', '..', 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const required = ['manifest_version', 'name', 'version', 'permissions', 'content_scripts', 'background'];
const missing = required.filter((key) => !(key in manifest));

if (missing.length > 0) {
  console.error(`manifest.json missing required fields: ${missing.join(', ')}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) {
  console.error(`Expected manifest_version 3, got ${manifest.manifest_version}`);
  process.exit(1);
}

console.log('manifest.json OK');
