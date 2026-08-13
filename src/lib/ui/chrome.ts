// Shared page chrome: the fixed wallet + settings controls in the top-right
// corner. Injected by every page module so the HTML shells stay minimal.
const SETTINGS_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.7 3.4 10.5 2h3l.8 1.4 1.8.7 1.5-.4 2.1 2.1-.4 1.5.7 1.8 1.4.8v3l-1.4.8-.7 1.8.4 1.5-2.1 2.1-1.5-.4-1.8.7-.8 1.4h-3l-.8-1.4-1.8-.7-1.5.4-2.1-2.1.4-1.5-.7-1.8L2 13.5v-3l1.4-.8.7-1.8-.4-1.5 2.1-2.1 1.5.4 1.8-.7Z"/><circle cx="12" cy="12" r="3"/></svg>';

export function injectChrome() {
  const controls = document.createElement('div');
  controls.className = 'top-controls';
  controls.innerHTML = '<button id="walletToggle" class="wallet-toggle" type="button">Connect wallet</button>'
    + `<button id="settingsToggle" class="settings-toggle" type="button" aria-label="Settings" title="Settings">${SETTINGS_ICON}</button>`;
  document.body.prepend(controls);
}
