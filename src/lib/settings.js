const STYLES = ['clarity', 'cipher', 'chambers'];
const STYLE_NAMES = {
  clarity: 'Clarity',
  cipher: 'Cipher',
  chambers: 'Chambers',
};
const STYLE_FONTS = {
  clarity: "'Inter', system-ui, sans-serif",
  cipher: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  chambers: "'Newsreader', Georgia, serif",
};

function currentStyle() {
  return document.documentElement.getAttribute('data-style') || 'clarity';
}

function applyStyle(style) {
  const next = STYLES.includes(style) ? style : 'clarity';
  if (next === 'clarity') document.documentElement.removeAttribute('data-style');
  else document.documentElement.setAttribute('data-style', next);
  document.documentElement.classList.toggle('dark', next === 'cipher');
  try { localStorage.setItem('pact-style', next); } catch (e) {}
}

function row(value, active) {
  const mark = active
    ? '<span class="setting-check active" aria-label="Selected"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span>'
    : '<span class="setting-check" aria-hidden="true"></span>';
  return `<button type="button" data-style="${value}"><span style="font-family: ${STYLE_FONTS[value]}">${STYLE_NAMES[value]}</span>${mark}</button>`;
}

function init(options) {
  const button = document.getElementById(options.buttonId);
  if (!button) return;
  const menu = document.createElement('div');
  menu.className = 'settings-menu';
  menu.setAttribute('role', 'menu');
  button.insertAdjacentElement('afterend', menu);

  function render() {
    const style = currentStyle();
    menu.innerHTML = `
      <div class="settings-group">
        <div class="settings-label">Style</div>
        ${STYLES.map(item => row(item, item === style)).join('')}
      </div>`;
  }

  button.addEventListener('click', () => {
    render();
    menu.classList.toggle('show');
  });

  menu.addEventListener('click', e => {
    const item = e.target.closest('[data-style]');
    if (!item) return;
    applyStyle(item.dataset.style);
    render();
    menu.classList.remove('show');
    if (options.onChange) options.onChange();
  });

  document.addEventListener('click', e => {
    if (button.contains(e.target) || menu.contains(e.target)) return;
    menu.classList.remove('show');
  });

  render();
}

export const PactSettings = { init, applyStyle };
