import { useEffect, useRef } from "react";

// Floating error tooltip shared by the agreement pages: hovering an element
// that carries [data-error] while in an error state shows its message above
// the field. Pass the page's error state so a fix that clears an error also
// hides a tooltip that's already showing.
export function useErrorTip(errors: unknown) {
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const errTip = document.createElement("div");
    errTip.className = "err-tip";
    document.body.appendChild(errTip);
    tipRef.current = errTip;
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.("[data-error]");
      if (
        el &&
        (el.classList.contains("error") || el.classList.contains("bad"))
      ) {
        errTip.textContent = el.getAttribute("data-error");
        const r = el.getBoundingClientRect();
        errTip.style.left = r.left + r.width / 2 + "px";
        errTip.style.top = r.top + "px";
        errTip.classList.add("show");
      }
    };
    // Hide unconditionally: the error may have cleared while hovering, in
    // which case the element no longer matches [data-error]. A still-errored
    // element re-shows via the mouseover that follows the same cursor move.
    const onOut = () => errTip.classList.remove("show");
    // Typing anywhere hides the tip (a change may fix the hovered field or
    // the derived totals row without ever leaving it).
    const onInput = () => errTip.classList.remove("show");
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("input", onInput);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("input", onInput);
      errTip.remove();
      tipRef.current = null;
    };
  }, []);

  // Blur-driven fixes (e.g. correcting the minimum clears the maximum's
  // error) can invalidate a tooltip that's already showing — hide it
  // whenever the error set changes.
  useEffect(() => {
    if (tipRef.current) tipRef.current.classList.remove("show");
  }, [errors]);
}
