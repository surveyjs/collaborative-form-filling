// Installs clients/angular dependencies (not an npm workspace, so the root
// `npm install` does not cover it). Runs from the root postinstall hook.
//
// Re-entrancy guard: clients/angular depends on the root project via
// "survey-collaboration": "file:../..", so installing the angular client
// triggers the root lifecycle scripts (including postinstall) again. The
// guard breaks that cycle after one level.
const { spawnSync } = require('child_process');
const path = require('path');

if (process.env.COLLAB_ANGULAR_INSTALL_RUNNING) {
  process.exit(0);
}

// npm_* vars from the parent npm lifecycle are stripped: they make a nested
// `npm install` target the parent project instead of the cwd.
const env = { COLLAB_ANGULAR_INSTALL_RUNNING: '1' };
for (const [key, value] of Object.entries(process.env)) {
  if (!/^npm_/i.test(key)) env[key] = value;
}

const targetDir = path.join(__dirname, '..', 'clients', 'angular');
console.log('[install-angular] installing dependencies in', targetDir);

const result = spawnSync('npm install', {
  cwd: targetDir,
  stdio: 'inherit',
  env,
  shell: true,
});

process.exit(result.status === null ? 1 : result.status);
