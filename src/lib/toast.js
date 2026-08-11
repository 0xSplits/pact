// Transient toast + copy-to-clipboard helpers shared by all pages.
let hideTimer = null;

export function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toast.classList.remove('show'), 1600);
}

export function copyText(text, message = 'Copied') {
  navigator.clipboard.writeText(text).then(() => showToast(message)).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(message);
    } catch (err) {}
    ta.remove();
  });
}
