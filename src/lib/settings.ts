const STYLES = ['clarity', 'cipher', 'chambers'] as const;
type Style = typeof STYLES[number];
const STYLE_NAMES: Record<Style, string> = {
  clarity: 'Clarity',
  cipher: 'Cipher',
  chambers: 'Chambers',
};
const STYLE_FONTS: Record<Style, string> = {
  clarity: "'Inter', system-ui, sans-serif",
  cipher: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  chambers: "'Newsreader', Georgia, serif",
};

function currentStyle(): Style {
  const style = document.documentElement.getAttribute('data-style');
  return (STYLES as readonly string[]).includes(style || '') ? style as Style : 'clarity';
}

function applyStyle(style: string): void {
  const next: Style = (STYLES as readonly string[]).includes(style) ? style as Style : 'clarity';
  if (next === 'clarity') document.documentElement.removeAttribute('data-style');
  else document.documentElement.setAttribute('data-style', next);
  document.documentElement.classList.toggle('dark', next === 'cipher');
  try { localStorage.setItem('pact-style', next); } catch (e) {}
}

function row(value: Style, active: boolean): string {
  const mark = active
    ? '<span class="setting-check active" aria-label="Selected"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span>'
    : '<span class="setting-check" aria-hidden="true"></span>';
  return `<button type="button" data-style="${value}"><span style="font-family: ${STYLE_FONTS[value]}">${STYLE_NAMES[value]}</span>${mark}</button>`;
}

function init(options: { buttonId: string; onChange?: () => void }): void {
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
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-style]');
    if (!item) return;
    applyStyle(item.dataset.style!);
    render();
    menu.classList.remove('show');
    if (options.onChange) options.onChange();
  });

  document.addEventListener('click', e => {
    if (button.contains(e.target as Node) || menu.contains(e.target as Node)) return;
    menu.classList.remove('show');
  });

  render();
}

export const PactSettings = { init, applyStyle };
