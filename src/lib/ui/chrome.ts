// Shared page chrome: the fixed wallet control in the top-right corner.
// Injected by every page module so the HTML shells stay minimal.
export function injectChrome() {
  const controls = document.createElement("div");
  controls.className = "top-controls";
  controls.innerHTML =
    '<span id="walletMount" style="display:contents"></span>';
  document.body.prepend(controls);
}
