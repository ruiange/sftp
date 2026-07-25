const { mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);
const releaseDirectory = path.join(projectRoot, 'release');
const outputPath = path.join(
  releaseDirectory,
  `${packageJson.name}-${packageJson.version}.vsix`,
);
const executable = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vsce.cmd' : 'vsce',
);

mkdirSync(releaseDirectory, { recursive: true });

const result = spawnSync(executable, ['package', '--out', outputPath], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
