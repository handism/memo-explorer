const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
(async () => {
  // Windows の一時フォルダは短い名前（RUNNER~1 など）になることがあり、ファイル監視が返す正式なパスと一致しないため展開しておく
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'memo-vscode-')));
  const userData = path.join(root, 'user-data');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.writeFile(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'memoExplorer.storagePath': path.join(root, 'notes'),
      'memoExplorer.dailyTemplate': '# {{date}}\n',
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none',
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off'
    })
  );
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, '../out/test/integration.js'),
      ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : {}),
      extensionTestsEnv: { MEMO_TEST_ROOT: root },
      launchArgs: [
        '--user-data-dir',
        userData,
        '--extensions-dir',
        path.join(root, 'extensions'),
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust'
      ]
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
