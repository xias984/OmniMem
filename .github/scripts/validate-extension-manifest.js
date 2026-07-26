const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', '..', 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const errors = [];

const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

if (manifest.manifest_version !== 3) {
  errors.push(`manifest_version must be 3, got ${JSON.stringify(manifest.manifest_version)}`);
}

if (!nonEmptyString(manifest.name)) {
  errors.push('name must be a non-empty string');
}

if (!nonEmptyString(manifest.version)) {
  errors.push('version must be a non-empty string');
}

if (!Array.isArray(manifest.permissions)) {
  errors.push('permissions must be an array');
}

if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
  errors.push('content_scripts must be a non-empty array');
} else {
  manifest.content_scripts.forEach((entry, i) => {
    if (!Array.isArray(entry?.js) || entry.js.length === 0) {
      errors.push(`content_scripts[${i}].js must be a non-empty array`);
    }
    if (!Array.isArray(entry?.matches) || entry.matches.length === 0) {
      errors.push(`content_scripts[${i}].matches must be a non-empty array`);
    }
  });
}

if (typeof manifest.background !== 'object' || manifest.background === null) {
  errors.push('background must be an object');
} else if (!nonEmptyString(manifest.background.service_worker)) {
  errors.push('background.service_worker must be a non-empty string');
}

if (errors.length > 0) {
  console.error('manifest.json validation failed:');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('manifest.json OK');
