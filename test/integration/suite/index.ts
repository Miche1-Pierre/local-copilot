import Mocha from 'mocha';

/** Entry point called by VS Code's test runner inside the extension host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: process.env.LOCAL_COPILOT_LIVE === '1' ? 300_000 : 60_000 });
  // The suite is bundled: install mocha's globals, then evaluate the test module.
  mocha.suite.emit('pre-require', globalThis, 'extension.test', mocha);
  require('./extension.test');
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
}
