// Approximates VS Code's Dark Modern theme variables so the webviews can be checked in a plain browser.
const vars = {
  '--vscode-foreground': '#cccccc',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-sideBar-background': '#181818',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-button-background': '#0078d4',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#026ec1',
  '--vscode-button-secondaryBackground': '#313131',
  '--vscode-button-secondaryForeground': '#cccccc',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-textCodeBlock-background': '#2b2b2b',
  '--vscode-editor-font-family': "Consolas, 'Courier New', monospace",
  '--vscode-editor-font-size': '14px',
  '--vscode-font-family': "-apple-system, 'Segoe UI', sans-serif",
  '--vscode-font-size': '13px',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-errorForeground': '#f85149',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-editorInfo-foreground': '#3794ff',
  '--vscode-testing-iconPassed': '#73c991',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-progressBar-background': '#0078d4',
  '--vscode-list-hoverBackground': '#2a2d2e',
};
for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
document.body.classList.add('vscode-dark');
window.__posted = [];
window.acquireVsCodeApi = () => ({
  postMessage: (m) => {
    window.__posted.push(m);
    if (m.type === 'ready' && window.__onReady) setTimeout(window.__onReady, 30);
  },
  getState: () => undefined,
  setState: () => {},
});
