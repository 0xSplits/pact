// Localhost-only debug menu for previewing offering states on the buy and
// status pages. Builds its own DOM so page shells stay minimal.
export const isLocalhost = () => ['localhost', '127.0.0.1'].includes(location.hostname);

export function initDebugMenu({ states, getState, setState }) {
  if (!isLocalhost()) return;
  const menu = document.createElement('div');
  menu.className = 'debug-menu show';
  menu.innerHTML = '<button class="debug-toggle" type="button">Debug</button>'
    + '<div class="debug-panel"><div class="debug-label">Offering state</div>'
    + states.map(({ value, label }) => `<button type="button" data-debug-state="${value}"><span>${label}</span><span class="debug-check" aria-hidden="true"></span></button>`).join('')
    + '</div>';
  document.body.appendChild(menu);
  const toggle = menu.querySelector('.debug-toggle');
  const panel = menu.querySelector('.debug-panel');

  function sync() {
    panel.querySelectorAll('[data-debug-state]').forEach(button => {
      button.classList.toggle('active', button.dataset.debugState === getState());
    });
  }
  toggle.addEventListener('click', () => {
    sync();
    panel.classList.toggle('show');
  });
  panel.addEventListener('click', e => {
    const button = e.target.closest('[data-debug-state]');
    if (!button) return;
    setState(button.dataset.debugState);
    sync();
    panel.classList.remove('show');
  });
  document.addEventListener('click', e => {
    if (menu.contains(e.target)) return;
    panel.classList.remove('show');
  });
  sync();
}
