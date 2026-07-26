const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const extensionDir = path.join(__dirname, '..', '..', 'extension');
const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const errors = [];
const jsFilesToCheck = new Set();

const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

// Risolve un path dichiarato nel manifest relativamente a extension/,
// rifiutando qualsiasi tentativo di uscirne (es. "../../etc/passwd").
function resolveWithinExtension(relPath, label) {
  const resolved = path.resolve(extensionDir, relPath);
  if (resolved !== extensionDir && !resolved.startsWith(extensionDir + path.sep)) {
    errors.push(`${label} ("${relPath}") esce dalla cartella extension/`);
    return null;
  }
  return resolved;
}

function checkFileExists(relPath, label) {
  if (!nonEmptyString(relPath)) {
    errors.push(`${label} deve essere una stringa non vuota`);
    return;
  }
  const resolved = resolveWithinExtension(relPath, label);
  if (resolved && !fs.existsSync(resolved)) {
    errors.push(`${label} punta a un file inesistente: ${relPath}`);
  }
}

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
    } else {
      entry.js.forEach((rel) => {
        checkFileExists(rel, `content_scripts[${i}].js`);
        if (nonEmptyString(rel)) jsFilesToCheck.add(rel);
      });
    }
    if (!Array.isArray(entry?.matches) || entry.matches.length === 0) {
      errors.push(`content_scripts[${i}].matches must be a non-empty array`);
    }
  });
}

if (typeof manifest.background !== 'object' || manifest.background === null) {
  errors.push('background must be an object');
} else {
  checkFileExists(manifest.background.service_worker, 'background.service_worker');
  if (nonEmptyString(manifest.background.service_worker)) {
    jsFilesToCheck.add(manifest.background.service_worker);
  }
}

if (manifest.action?.default_popup) {
  checkFileExists(manifest.action.default_popup, 'action.default_popup');
}

for (const [size, rel] of Object.entries(manifest.action?.default_icon ?? {})) {
  checkFileExists(rel, `action.default_icon["${size}"]`);
}

for (const [size, rel] of Object.entries(manifest.icons ?? {})) {
  checkFileExists(rel, `icons["${size}"]`);
}

// I file JS dichiarati dal manifest vengono passati direttamente a
// `node --check`, non solo coperti dal glob extension/*.js del workflow
// (che tra l'altro non intercetterebbe un service_worker/content script
// rinominato ma ancora referenziato con il vecchio nome).
for (const rel of jsFilesToCheck) {
  const resolved = resolveWithinExtension(rel, 'file JS referenziato');
  if (!resolved || !fs.existsSync(resolved)) continue; // già segnalato sopra
  try {
    execFileSync(process.execPath, ['--check', resolved], { stdio: 'pipe' });
  } catch (err) {
    errors.push(`sintassi non valida in ${rel}: ${err.stderr?.toString().trim() || err.message}`);
  }
}

if (errors.length > 0) {
  console.error('manifest.json validation failed:');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('manifest.json OK');
