// Shared bonding-curve chart.
// cfg: { vMin, vMax, cap, F, totalTokens, fMin?, fillF?, hoverF?, defaultF?, forceLight?, showThreshold? }
//   fMin  — threshold fraction (where the minimum raise is reached) → marker
//   fillF — current fill fraction (how far the round has sold) → "Now" marker + shading
//   hoverF — readout fraction → post-money valuation and price-per-token pill
export function drawCurve(canvas, cfg) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, pad = 78;
  const { vMin, vMax, cap, F, totalTokens, fMin, fillF } = cfg;
  const hoverF = cfg.hoverF == null ? cfg.defaultF : cfg.hoverF;
  const dark = !cfg.forceLight && document.documentElement.classList.contains('dark');
  const P = dark
    ? { bg:'#15171c', axis:'#565d69', capLine:'#3a4150', capText:'#8b93a1', curve:'#e7e7e7', text:'#e7e7e7', caption:'#8b93a1', marker:'#7ea8ff', markerFill:'rgba(126,168,255,0.16)', fill:'#57c98a', fillArea:'rgba(87,201,138,0.20)', hoverArea:'rgba(126,168,255,0.14)', sliceFill:'rgba(167,139,250,0.28)', sliceText:'#a78bfa' }
    : { bg:'#ffffff', axis:'#888888', capLine:'#bbbbbb', capText:'#666666', curve:'#111111', text:'#111111', caption:'#444444', marker:'#2563eb', markerFill:'rgba(37,99,235,0.10)', fill:'#2f8f5b', fillArea:'rgba(47,143,91,0.14)', hoverArea:'rgba(37,99,235,0.08)', sliceFill:'rgba(124,92,246,0.22)', sliceText:'#6d44e0' };

  const cmoney = v => v >= 1e6 ? '$' + (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 2) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'K' : '$' + Math.round(v);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = P.bg; ctx.fillRect(0, 0, W, H);
  if (!cap || F <= 0) return;

  const x0 = pad, x1 = W - pad, y0 = H - pad, y1 = pad;
  const yLo = vMin * 0.9, yHi = vMax * 1.05;
  const sx = f => x0 + (f / F) * (x1 - x0);
  const sy = v => y0 - ((v - yLo) / (yHi - yLo)) * (y0 - y1);
  const fontFam = getComputedStyle(document.body).fontFamily || "'IBM Plex Mono', monospace";
  const mono = px => `${px}px ${fontFam}`;
  const valAt = f => vMin + (vMax - vMin) * (f / F);

  // axes
  ctx.strokeStyle = P.axis; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();

  const hasFill = fillF != null && fillF > 0;
  const hasMin = cfg.showThreshold !== false && fMin != null && fMin > 0 && fMin < F * 0.999;
  const hasSlice = cfg.slice && cfg.slice.to > cfg.slice.from;
  const slf = hasSlice ? Math.max(0, Math.min(F, cfg.slice.from)) : 0;
  const slt = hasSlice ? Math.max(0, Math.min(F, cfg.slice.to)) : 0;

  // current-fill shading (sold so far)
  if (hasFill) {
    const ff = Math.min(fillF, F);
    ctx.fillStyle = P.fillArea;
    ctx.beginPath();
    ctx.moveTo(sx(0), y0); ctx.lineTo(sx(ff), y0); ctx.lineTo(sx(ff), sy(valAt(ff))); ctx.lineTo(sx(0), sy(vMin));
    ctx.closePath(); ctx.fill();
  } else if (hasMin) {
    // on the blank template, shade the threshold region instead
    const vt = valAt(fMin);
    ctx.fillStyle = P.markerFill;
    ctx.beginPath();
    ctx.moveTo(sx(0), y0); ctx.lineTo(sx(fMin), y0); ctx.lineTo(sx(fMin), sy(vt)); ctx.lineTo(sx(0), sy(vMin));
    ctx.closePath(); ctx.fill();
  }

  // hover fill preview (how far the round has filled at the hovered valuation)
  if (hoverF != null && !hasFill) {
    const hf = Math.min(hoverF, F);
    ctx.fillStyle = P.hoverArea;
    ctx.beginPath();
    ctx.moveTo(sx(0), y0); ctx.lineTo(sx(hf), y0); ctx.lineTo(sx(hf), sy(valAt(hf))); ctx.lineTo(sx(0), sy(vMin));
    ctx.closePath(); ctx.fill();
  }

  // buyer's slice region
  if (hasSlice) {
    ctx.fillStyle = P.sliceFill;
    ctx.beginPath();
    ctx.moveTo(sx(slf), y0); ctx.lineTo(sx(slt), y0); ctx.lineTo(sx(slt), sy(valAt(slt))); ctx.lineTo(sx(slf), sy(valAt(slf)));
    ctx.closePath(); ctx.fill();
  }

  // curve
  ctx.strokeStyle = P.curve; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(sx(0), sy(vMin)); ctx.lineTo(sx(F), sy(vMax)); ctx.stroke();
  ctx.fillStyle = P.curve;
  for (const [f, v] of [[0, vMin], [F, vMax]]) { ctx.beginPath(); ctx.arc(sx(f), sy(v), 6, 0, 7); ctx.fill(); }

  // threshold marker
  if (hasMin) {
    const fx = sx(fMin), vt = valAt(fMin);
    ctx.strokeStyle = P.marker; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(fx, y0); ctx.lineTo(fx, sy(vt)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = P.marker; ctx.beginPath(); ctx.arc(fx, sy(vt), 6, 0, 7); ctx.fill();
    ctx.font = mono(26); ctx.textAlign = 'center'; ctx.fillText('Threshold', fx, sy(vt) - 18);
  }

  // current-fill marker ("Now")
  if (hasFill) {
    const ff = Math.min(fillF, F), fx = sx(ff), vt = valAt(ff);
    ctx.strokeStyle = P.fill; ctx.lineWidth = 2; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(fx, y0); ctx.lineTo(fx, sy(vt)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = P.fill; ctx.beginPath(); ctx.arc(fx, sy(vt), 7, 0, 7); ctx.fill();
    ctx.font = mono(26); ctx.textAlign = 'center'; ctx.fillText(cfg.fillLabel || 'Now', fx, sy(vt) - 18);
  }

  // buyer's slice end marker + label
  if (hasSlice) {
    ctx.strokeStyle = P.sliceText; ctx.lineWidth = 2; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(sx(slt), y0); ctx.lineTo(sx(slt), sy(valAt(slt))); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = P.sliceText; ctx.beginPath(); ctx.arc(sx(slt), sy(valAt(slt)), 6, 0, 7); ctx.fill();
    ctx.font = mono(26); ctx.textAlign = 'center'; ctx.fillText(cfg.slice.label || 'You', sx((slf + slt) / 2), sy(valAt(slt)) - 18);
  }

  // endpoint value labels
  ctx.fillStyle = P.text; ctx.font = mono(30);
  ctx.textAlign = 'left';  ctx.fillText(cmoney(vMin), sx(0) + 14, sy(vMin) + 34);
  ctx.textAlign = 'right'; ctx.fillText(cmoney(vMax), sx(F) - 14, sy(vMax) - 18);

  // axis captions
  ctx.fillStyle = P.caption; ctx.font = mono(28); ctx.textAlign = 'center';
  ctx.fillText('0', sx(0), y0 + 40);
  ctx.fillText(Math.round(F * totalTokens).toLocaleString('en-US'), sx(F), y0 + 40);
  ctx.fillText('Tokens sold', (x0 + x1) / 2, H - 22);
  ctx.save();
  ctx.translate(28, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('Post-money valuation', 0, 0);
  ctx.restore();

  // hover readout
  if (hoverF != null) {
    const hx = sx(hoverF), vAt = valAt(hoverF), hy = sy(vAt);
    ctx.strokeStyle = P.caption; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(hx, y0); ctx.lineTo(hx, hy); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = P.marker; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(x0, hy); ctx.lineTo(hx, hy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = P.curve; ctx.beginPath(); ctx.arc(hx, hy, 7, 0, 7); ctx.fill();
    const primary = cmoney(vAt) + ' post-money';
    const secondary = '$' + (vAt / totalTokens).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' / token';
    ctx.font = `500 ${mono(25)}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const primaryWidth = ctx.measureText(primary).width;
    ctx.font = mono(25);
    const secondaryWidth = ctx.measureText(secondary).width;
    const tw = Math.max(primaryWidth, secondaryWidth), bw = tw + 32, bh = 78;
    const lx = Math.max(x0 + bw / 2, Math.min(x1 - bw / 2, hx));
    const ly = Math.max(y1 + bh / 2, hy - 54);
    ctx.fillStyle = P.bg; ctx.fillRect(lx - bw / 2, ly - bh / 2, bw, bh);
    ctx.strokeStyle = P.axis; ctx.lineWidth = 1; ctx.strokeRect(lx - bw / 2, ly - bh / 2, bw, bh);
    ctx.fillStyle = P.text; ctx.font = `500 ${mono(25)}`; ctx.fillText(primary, lx, ly - 16);
    ctx.fillStyle = P.caption; ctx.font = mono(25); ctx.fillText(secondary, lx, ly + 18);
    ctx.textBaseline = 'alphabetic';
  }
}

// Wire hover on a canvas. getCfg() returns the current base cfg (without hoverF).
export function attachCurveHover(canvas, getCfg) {
  canvas.addEventListener('mousemove', e => {
    const cfg = getCfg();
    if (!cfg || !cfg.cap || cfg.F <= 0) return;
    const pad = 78, x0 = pad, x1 = canvas.width - pad;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width * canvas.width;
    let f = (cx - x0) / (x1 - x0) * cfg.F;
    f = Math.max(0, Math.min(cfg.F, f));
    drawCurve(canvas, Object.assign({}, cfg, { hoverF: f }));
  });
  canvas.addEventListener('mouseleave', () => {
    const cfg = getCfg();
    if (cfg) drawCurve(canvas, Object.assign({}, cfg, { hoverF: null }));
  });
}
