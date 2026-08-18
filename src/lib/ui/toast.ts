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

export function copyText(text: string, message: string = "Copied"): void {
  navigator.clipboard
    .writeText(text)
    .then(() => showToast(message))
    .catch(() => showToast("Copy failed"));
}
