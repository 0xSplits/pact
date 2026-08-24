// Canvas bonding-curve chart shared by the create and status pages. The
// vanilla drawCurve/attachCurveHover helpers repaint the canvas directly;
// React only owns the element, so hover reads the latest config through a
// ref. Redraws when the system color scheme flips, and prints in the light
// palette regardless of the on-screen theme — flushSync forces the redraw to
// commit before the browser captures the print snapshot.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { attachCurveHover, drawCurve } from "#lib/ui/chart.ts";
import type { CurveChartConfig } from "#lib/ui/chart.ts";

export function CurveChart({
  curveState,
  interactive = true,
}: {
  curveState: CurveChartConfig | null;
  interactive?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfgRef = useRef<CurveChartConfig | null>(null);
  const [forceLight, setForceLight] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  cfgRef.current = curveState
    ? {
        ...curveState,
        forceLight,
        defaultF: curveState.defaultF ?? curveState.fMin,
        showThreshold: curveState.showThreshold ?? false,
      }
    : null;

  useEffect(() => {
    if (interactive) attachCurveHover(canvasRef.current!, () => cfgRef.current);
  }, [interactive]);

  useEffect(() => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => setThemeTick((tick) => tick + 1);
    scheme.addEventListener("change", onScheme);
    const before = () => flushSync(() => setForceLight(true));
    const after = () => flushSync(() => setForceLight(false));
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      scheme.removeEventListener("change", onScheme);
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  // Layout effect (not passive) so the redraw commits before the browser
  // paints or captures a print snapshot.
  useLayoutEffect(() => {
    if (cfgRef.current) drawCurve(canvasRef.current!, cfgRef.current);
  }, [curveState, forceLight, themeTick]);

  return (
    <canvas
      ref={canvasRef}
      id="chart"
      width="1344"
      height="620"
      className="w-full block"
    />
  );
}
