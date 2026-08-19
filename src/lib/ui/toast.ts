// Transient toast + copy-to-clipboard helpers shared by all pages.
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string): void {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toast!.classList.remove("show"), 2500);
}

// Clipboard writes need transient user activation, which expires while the
// wallet popup is up. Callers whose copy runs after an async wallet round-trip
// should pass a fallback message that steers the user to a manual button.
export function copyText(
  text: string,
  message: string = "Copied",
  fallbackMessage: string = "Copy failed",
): void {
  navigator.clipboard
    .writeText(text)
    .then(() => showToast(message))
    .catch(() => showToast(fallbackMessage));
}
