import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import './create.css';
import { injectChrome } from '../lib/chrome.js';
import { PactAPI } from '../lib/api.js';
import { PactWallet } from '../lib/wallet.js';
import { PactSettings } from '../lib/settings.js';
import { useWallet } from '../lib/use-wallet.js';
import { drawCurve, attachCurveHover } from '../lib/chart.js';
import { isAddress } from '../lib/validate.js';
import { TOTAL_LIQUID_SPLIT_UNITS } from '../lib/liquid-split.js';
import { createOffering } from '../lib/onchain.js';
import { Button } from '../components/ui.jsx';
import { pactPath } from '../lib/routes.js';
import { showToast } from '../lib/toast.js';

const TOTAL_SHARES = TOTAL_LIQUID_SPLIT_UNITS; // 0.1% = 1 token
const fmtFull = v => '$' + Math.round(v).toLocaleString('en-US');
const oneDecimal = v => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1);
const fmtPct = v => oneDecimal(v) + '%';
const fmtShares = v => Math.round(v).toLocaleString('en-US');
const parseMoney = s => +String(s).replace(/[^0-9.]/g, '') || 0;

// One-decimal clamp for percentage inputs (dilution, holder rows).
function clamp1(value, max = 100) {
  let v = value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  const [int, dec] = v.split('.');
  if (dec && dec.length > 1) v = int + '.' + dec.slice(0, 1);
  if (Number(v) > max) v = String(max);
  return v;
}

function formatMoneyInput(value) {
  const digits = value.replace(/[^0-9]/g, '');
  return digits ? Number(digits).toLocaleString('en-US') : '';
}

function randomName() {
  const adj = ['Amber','Lucid','Velvet','Crimson','Golden','Silent','Cobalt','Nimble','Hidden','Lunar','Solar','Quiet','Swift','Ember','Frost','Jade','Onyx','Coral','Misty','Noble','Vivid','Bright','Wild','Brave','Dusk'];
  const noun = ['Harbor','Meadow','Otter','Falcon','Cedar','Comet','Atlas','Garden','Foundry','Beacon','Compass','Orchard','Summit','Delta','Haven','Forge','Willow','Lantern','Harvest','Quarry','Ridge','Cove','Anchor','Maple','Heron'];
  const pick = a => a[Math.floor(Math.random() * a.length)];
  return pick(adj) + ' ' + pick(noun);
}

// Derive everything the document and chart need from the raw form values.
function deriveCurve(form, holders) {
  const raiseMax = parseMoney(form.raiseMax);
  const raiseMin = parseMoney(form.raiseMin);
  const dilution = (+form.dilution || 0) / 100;
  const spread = (+form.spread || 0) / 100;
  const cap = dilution > 0 ? raiseMax / dilution : 0;
  const vMin = cap * (1 - spread);
  const vMax = cap * (1 + spread);

  // where the minimum raise lands on the curve (inverse of area under the curve)
  const F = dilution;
  let fMin = 0;
  if (cap && raiseMin > 0) {
    if (raiseMin >= raiseMax) fMin = F;
    else if (vMax === vMin) fMin = Math.min(raiseMin / cap, F);
    else {
      const a = (vMax - vMin) / (2 * F);
      fMin = Math.min((-vMin + Math.sqrt(vMin * vMin + 4 * a * raiseMin)) / (2 * a), F);
    }
  }

  const keep = 1 - dilution;
  let beforeSum = 0, sharesSum = 0;
  const rows = holders.map(h => {
    const pct = +h.pct || 0;
    beforeSum += pct;
    const after = pct * keep;
    const shares = (after / 100) * TOTAL_SHARES;
    sharesSum += Math.round(shares);
    return { ...h, after, shares };
  });
  const newShares = Math.round(dilution * TOTAL_SHARES);
  sharesSum += newShares;
  const afterSum = beforeSum * keep + dilution * 100;

  return {
    raiseMin, raiseMax, dilution, spread, cap, vMin, vMax, fMin,
    rows, newShares, beforeSum, afterSum, sharesSum,
    curveState: { vMin, vMax, cap, F: dilution, fMin, totalTokens: TOTAL_SHARES },
  };
}

// Per-field validation, shared by blur ("touched") checks and submit.
function requiredFieldError(key, form) {
  const rmin = parseMoney(form.raiseMin);
  const rmax = parseMoney(form.raiseMax);
  switch (key) {
    case 'projectName':
      return form.projectName.trim() ? '' : 'Enter a project name.';
    case 'raiseMin':
      if (!(rmin > 0)) return 'Enter a minimum raise.';
      if (rmax > 0 && rmin > rmax) return 'Minimum cannot exceed the maximum.';
      return '';
    case 'raiseMax':
      if (!(rmax > 0)) return 'Enter a maximum raise.';
      if (rmin > 0 && rmin > rmax) return 'Maximum cannot be below the minimum.';
      return '';
    case 'days':
      return +form.days >= 1 ? '' : 'Enter a valid number of days.';
    case 'dilution':
      return +form.dilution > 0 && +form.dilution < 100 ? '' : 'Must be greater than 0 and less than 100%.';
    case 'proceeds':
      return isAddress(form.proceeds) ? '' : 'Enter a valid 0x address (40 hex).';
    default:
      return '';
  }
}

function formIsValid(form, holders, d) {
  const dil = +form.dilution;
  return !!form.projectName.trim()
    && d.raiseMin > 0
    && d.raiseMax > 0
    && d.raiseMin <= d.raiseMax
    && +form.days >= 1
    && dil > 0
    && dil < 100
    && isAddress(form.proceeds)
    && holders.length > 0
    && holders.every(h => isAddress(h.name) && +h.pct > 0)
    && Math.abs(d.beforeSum - 100) <= 0.05;
}

function buildPact(form, holders, wallet) {
  const rmin = parseMoney(form.raiseMin);
  const rmax = parseMoney(form.raiseMax);
  const dilution = (+form.dilution || 0) / 100;
  const spread = (+form.spread || 0) / 100;
  const cap = rmax / dilution;
  const keep = 1 - dilution;
  return {
    projectName: form.projectName.trim(),
    raise: { min: rmin, max: rmax },
    minimum: { deadlineDays: +form.days, refundIfUnmet: 'burn-tokens-for-full-purchase-amount' },
    issuerWallet: wallet,
    maximum: { reclaimUnsoldBy: 'project-treasury' },
    maxDilutionPct: +form.dilution,
    proceedsAddress: form.proceeds.trim(),
    valuation: {
      effectiveCap: Math.round(cap),
      bandPct: +form.spread,
      floor: Math.round(cap * (1 - spread)),
      ceiling: Math.round(cap * (1 + spread)),
      curve: 'linear-in-tokens',
    },
    totalTokens: TOTAL_SHARES,
    holders: holders.map(h => ({
      address: h.name.trim(),
      beforePct: +h.pct || 0,
      afterPct: Math.round((+h.pct || 0) * keep * 10) / 10,
      tokens: Math.round((+h.pct || 0) * keep / 100 * TOTAL_SHARES),
      delivery: 'direct',
    })),
    newMoney: {
      afterPct: +form.dilution,
      tokens: Math.round(dilution * TOTAL_SHARES),
      delivery: 'bonding-curve',
    },
  };
}

// Canvas chart. The vanilla drawCurve/attachCurveHover helpers repaint the
// canvas directly; React only owns the element, so hover reads the latest
// config through a ref.
function CurveChart({ curveState, forceLight, themeTick }) {
  const canvasRef = useRef(null);
  const cfgRef = useRef(null);
  cfgRef.current = curveState
    ? { ...curveState, forceLight, defaultF: curveState.fMin, showThreshold: false }
    : null;

  useEffect(() => {
    attachCurveHover(canvasRef.current, () => cfgRef.current);
  }, []);

  // Layout effect (not passive) so the redraw commits before the browser
  // paints or captures a print snapshot — the print handler pairs this with
  // flushSync so switching to the light palette lands before Cmd+P prints.
  useLayoutEffect(() => {
    if (cfgRef.current) drawCurve(canvasRef.current, cfgRef.current);
  }, [curveState, forceLight, themeTick]);

  return <canvas ref={canvasRef} id="chart" width="1344" height="620" className="w-full block" />;
}

function CreateApp() {
  const [form, setForm] = useState(() => ({
    projectName: randomName(),
    raiseMin: '5,000',
    raiseMax: '10,000',
    days: '30',
    dilution: '20',
    spread: '20',
    proceeds: '',
  }));
  const uidRef = useRef(2);
  const [holders, setHolders] = useState([
    { id: 1, name: '', pct: '50.0' },
    { id: 2, name: '', pct: '50.0' },
  ]);
  const [lastAddedId, setLastAddedId] = useState(null);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forceLightChart, setForceLightChart] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const errTipRef = useRef(null);

  const wallet = useWallet({ onError: err => showToast(err.message || 'Could not connect wallet.') });
  useEffect(() => { setFormError(''); }, [wallet]);

  useEffect(() => {
    PactSettings.init({ buttonId: 'settingsToggle', onChange: () => setThemeTick(t => t + 1) });

    // floating error tooltip — shows a field's message on hover while it's in an error state
    const errTip = document.createElement('div');
    errTip.className = 'err-tip';
    document.body.appendChild(errTip);
    errTipRef.current = errTip;
    const onOver = e => {
      const el = e.target.closest && e.target.closest('[data-error]');
      if (el && (el.classList.contains('error') || el.classList.contains('bad'))) {
        errTip.textContent = el.getAttribute('data-error');
        const r = el.getBoundingClientRect();
        errTip.style.left = (r.left + r.width / 2) + 'px';
        errTip.style.top = r.top + 'px';
        errTip.classList.add('show');
      }
    };
    // Hide unconditionally: the error may have cleared while hovering, in
    // which case the element no longer matches [data-error]. A still-errored
    // element re-shows via the mouseover that follows the same cursor move.
    const onOut = () => errTip.classList.remove('show');
    // Typing anywhere hides the tip (a change may fix the hovered field or
    // the derived totals row without ever leaving it).
    const onInput = () => errTip.classList.remove('show');
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('input', onInput);

    // print the chart in the light palette regardless of on-screen theme.
    // flushSync forces the re-render + layout-effect redraw to commit
    // synchronously, before the browser captures the print snapshot.
    const before = () => flushSync(() => setForceLightChart(true));
    const after = () => flushSync(() => setForceLightChart(false));
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('input', onInput);
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
      errTip.remove();
    };
  }, []);

  // Blur-driven fixes (e.g. correcting the minimum clears the maximum's
  // error) can invalidate a tooltip that's already showing — hide it
  // whenever the error set changes.
  useEffect(() => {
    if (errTipRef.current) errTipRef.current.classList.remove('show');
  }, [errors]);

  const d = deriveCurve(form, holders);
  const valid = formIsValid(form, holders, d);
  const disabled = !valid || !wallet;
  const tip = disabled
    ? (valid ? 'Connect wallet to create issuance' : 'Complete required fields to create issuance')
    : '';

  // Editing a field clears its own error and the form-level message,
  // like the old page's document-level input listener.
  function setField(key, value) {
    setForm(f => ({ ...f, [key]: value }));
    clearError(key);
  }
  function clearError(key) {
    setErrors(e => (key in e ? { ...e, [key]: undefined } : e));
    setFormError('');
  }
  function setHolder(id, patch, errKey) {
    setHolders(hs => hs.map(h => h.id === id ? { ...h, ...patch } : h));
    clearError(errKey);
  }

  // Blur validation: leaving a required field empty or invalid marks it
  // immediately instead of waiting for a submit that can't happen while
  // the button is disabled. The raise pair is checked together so
  // min > max flags both fields.
  function touch(...keys) {
    setErrors(e => {
      const next = { ...e };
      for (const key of keys) next[key] = requiredFieldError(key, form) || undefined;
      return next;
    });
  }
  function touchHolderName(h) {
    setErrors(e => ({ ...e, ['name-' + h.id]: isAddress(h.name) ? undefined : 'Enter a valid 0x address.' }));
  }
  function touchHolderPct(h, value) {
    setErrors(e => ({ ...e, ['pct-' + h.id]: +value > 0 ? undefined : 'Enter a percentage greater than 0.' }));
  }

  function addHolder() {
    const id = ++uidRef.current;
    setHolders(hs => [...hs, { id, name: '', pct: '0.0' }]);
    setLastAddedId(id);
    setFormError('');
  }
  function removeHolder(id) {
    setHolders(hs => hs.filter(h => h.id !== id));
    setFormError('');
  }

  function validate() {
    const errs = {};
    for (const key of ['projectName', 'raiseMin', 'raiseMax', 'days', 'dilution', 'proceeds']) {
      const msg = requiredFieldError(key, form);
      if (msg) errs[key] = msg;
    }
    holders.forEach(h => {
      if (!isAddress(h.name)) errs['name-' + h.id] = 'Enter a valid 0x address.';
      if (!(+h.pct > 0)) errs['pct-' + h.id] = 'Enter a percentage greater than 0.';
      if (!/^\d+(\.\d)$/.test(String(h.pct).trim())) errs['pct-' + h.id] = 'Enter exactly one decimal place.';
    });
    const anyErrors = Object.keys(errs).length > 0;
    const ok = !anyErrors && !!wallet && holders.length > 0 && Math.abs(d.beforeSum - 100) <= 0.05;
    setErrors(errs);
    return ok;
  }

  async function create() {
    if (!validate()) {
      setFormError(wallet ? 'Please correct the highlighted fields — hover for details.' : 'Connect a wallet before creating an issuance.');
      return;
    }
    setBusy(true);
    try {
      const data = buildPact(form, holders, wallet);
      const deployment = await createOffering({
        provider: PactWallet.provider,
        pact: data,
        owner: wallet,
      });
      data.chainId = deployment.chainId;
      data.offeringAddress = deployment.offeringAddress;
      data.offeringTxHash = deployment.transactionHash;
      data.paymentToken = deployment.paymentToken;
      data.curveParams = deployment.curve;
      data.liquidSplitAddress = deployment.liquidSplitAddress;
      const pact = await PactAPI.createPact(data);
      window.location.href = pactPath(pact.id);
    } catch (err) {
      setFormError(err.message || 'Could not create issuance.');
      setBusy(false);
    }
  }

  const errProps = key => ({
    className: errors[key] ? ' error' : '',
    'data-error': errors[key] || undefined,
  });
  const totalProps = (bad, msg) => ({
    className: 'num' + (bad ? ' bad' : ''),
    'data-error': bad ? msg : undefined,
  });
  const badBefore = Math.abs(d.beforeSum - 100) >= 0.05;
  const badAfter = Math.abs(d.afterSum - 100) >= 0.05;
  const badShares = d.sharesSum !== TOTAL_SHARES;

  return (
    <>
      {/* Version */}
      <div className="text-right text-sm font-bold mb-6">Version 1.0</div>

      {/* Title */}
      <div className="mb-9">
        <h1 className="text-2xl font-bold uppercase tracking-wide text-center">Purchase Agreement for Community Tokens</h1>
        <p className="text-sm mt-4 uppercase text-justify">The Tokens issued pursuant to this instrument carry no inherent value and entitle their holders to nothing except as the Project&rsquo;s creator may expressly provide. They exist solely to align their holders with the Project, and it is for the creator to determine what, if anything, the Tokens are used for.</p>
      </div>

      {/* Recital */}
      <p className="mb-9 text-justify">
        This Purchase Agreement for Community Tokens (this &ldquo;PACT&rdquo;) certifies that{' '}
        <input id="projectName" className={'blank w-44' + errProps('projectName').className} data-error={errors.projectName || undefined} type="text" placeholder="Project name" autoComplete="off" value={form.projectName} onChange={e => setField('projectName', e.target.value)} onBlur={() => touch('projectName')} /> (the &ldquo;Project&rdquo;)
        shall issue community tokens (the &ldquo;Tokens&rdquo;) to those who buy into the Offering described below,
        upon and subject to the terms set forth herein.
      </p>

      {/* The Offering */}
      <p className="mb-4 text-justify">
        <span className="font-bold">&sect;1. The Offering.</span>
        {' '}The Project intends to raise no less than ${''}
        <input id="raiseMin" className={'blank w-24 text-center' + errProps('raiseMin').className} data-error={errors.raiseMin || undefined} type="text" inputMode="numeric" autoComplete="off" value={form.raiseMin} onChange={e => setField('raiseMin', formatMoneyInput(e.target.value))} onBlur={() => touch('raiseMin', 'raiseMax')} /> (the &ldquo;Minimum&rdquo;)
        and no more than ${''}
        <input id="raiseMax" className={'blank w-24 text-center' + errProps('raiseMax').className} data-error={errors.raiseMax || undefined} type="text" inputMode="numeric" autoComplete="off" value={form.raiseMax} onChange={e => setField('raiseMax', formatMoneyInput(e.target.value))} onBlur={() => touch('raiseMin', 'raiseMax')} /> (the &ldquo;Maximum&rdquo;)
        of new capital and, in consideration thereof, shall make available for purchase no more than{' '}
        <input id="dilution" className={'blank w-12 text-center' + errProps('dilution').className} data-error={errors.dilution || undefined} type="number" min="0.1" max="99.9" step="0.1" autoComplete="off" value={form.dilution} onChange={e => setField('dilution', clamp1(e.target.value, 99.9))} onBlur={() => touch('dilution')} />%
        of the Tokens (the &ldquo;Offering&rdquo;).
      </p>
      <p className="mb-9 text-justify">
        Should the Minimum not be met within{' '}
        <input id="days" className={'blank w-12 text-center' + errProps('days').className} data-error={errors.days || undefined} type="number" min="1" step="1" autoComplete="off" value={form.days} onChange={e => setField('days', e.target.value)} onBlur={() => touch('days')} /> days of issuance (the &ldquo;Close Date&rdquo;),
        buyers shall be entitled to burn their Tokens and reclaim the full amount of their purchase.
        Should the Maximum not be met, any unsold Tokens may be reclaimed solely by the Treasury.
      </p>

      {/* Use of Proceeds */}
      <p className="mb-9 text-justify">
        <span className="font-bold">&sect;2. Use of Proceeds.</span>
        {' '}The net proceeds of the Offering shall be delivered to the Project&rsquo;s treasury account (the &ldquo;Treasury&rdquo;) at{' '}
        <input id="proceeds" className={'blank w-96 max-w-full text-left' + errProps('proceeds').className} data-error={errors.proceeds || undefined} type="text" placeholder="0x address…" autoComplete="off" value={form.proceeds} onChange={e => setField('proceeds', e.target.value)} onBlur={() => touch('proceeds')} />.
      </p>

      {/* Capitalization */}
      <p className="mb-3"><span className="font-bold">&sect;3. Capitalization.</span> The capital structure of the Project, before and after the Offering, shall be as set forth below:</p>
      <table className="exhibit mb-2">
        <thead>
          <tr><th className="w-[58%]">Holder</th><th className="num">Before</th><th className="num">After</th><th className="num">Tokens</th><th className="w-6"></th></tr>
        </thead>
        <tbody id="holders">
          {d.rows.map(h => (
            <tr key={h.id}>
              <td><input type="text" className={'blank w-full' + (errors['name-' + h.id] ? ' error' : '')} data-error={errors['name-' + h.id] || undefined} data-k="name" placeholder="0x address…" autoComplete="off" autoFocus={h.id === lastAddedId} value={h.name} onChange={e => setHolder(h.id, { name: e.target.value }, 'name-' + h.id)} onBlur={() => touchHolderName(h)} /></td>
              <td className="num"><input type="text" inputMode="decimal" className={'blank w-12 text-right' + (errors['pct-' + h.id] ? ' error' : '')} data-error={errors['pct-' + h.id] || undefined} data-k="pct" autoComplete="off" value={h.pct} onChange={e => setHolder(h.id, { pct: clamp1(e.target.value) }, 'pct-' + h.id)} onBlur={e => { const v = oneDecimal(e.target.value); setHolder(h.id, { pct: v }, 'pct-' + h.id); touchHolderPct(h, v); }} />%</td>
              <td className="num">{fmtPct(h.after)}</td>
              <td className="num">{fmtShares(h.shares)}</td>
              <td className="num w-6"><button className="delx" title="Remove" onClick={() => removeHolder(h.id)}>&times;</button></td>
            </tr>
          ))}
        </tbody>
        <tbody>
          <tr className="addrow"><td colSpan={5}><button id="addHolder" onClick={addHolder}>+ Add holder</button></td></tr>
          <tr className="highlight">
            <td><em>New money from the Offering</em></td>
            <td className="num">&mdash;</td>
            <td className="num" id="newPost">{fmtPct(d.dilution * 100)}</td>
            <td className="num" id="newShares">{fmtShares(d.newShares)}</td>
            <td></td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td {...totalProps(badBefore, 'Holder percentages must total 100%.')} id="beforeTotal">{fmtPct(d.beforeSum)}</td>
            <td {...totalProps(badAfter, 'Post-raise must total 100%.')} id="afterTotal">{fmtPct(d.afterSum)}</td>
            <td {...totalProps(badShares, 'Tokens must total ' + TOTAL_SHARES.toLocaleString('en-US') + '.')} id="sharesTotal">{fmtShares(d.sharesSum)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      <p className="mt-3 text-sm leading-5 t-muted italic">
        Upon issuance, each holder shall receive their Tokens, as defined above. The Tokens allocated to the Offering shall be deposited into the bonding curve (the &ldquo;Curve&rdquo;) and sold along the Resulting Terms below.
      </p>

      {/* Resulting Terms */}
      <p className="mt-9 mb-8 text-justify">
        <span className="font-bold">&sect;4. Resulting Terms.</span>
        {' '}Accordingly, upon full subscription the effective post-money valuation shall be <span className="font-bold" id="capOut">{d.cap ? fmtFull(d.cap) : '—'}</span>.
        Subscriptions shall be accepted along the Curve, spanning a valuation band of
        &plusmn;<input id="spread" className="blank w-10 text-center" type="number" min="0" max="60" step="1" autoComplete="off" value={form.spread} onChange={e => setField('spread', e.target.value)} />%
        about the cap &mdash; beginning at a floor of <span className="font-bold" id="vMinOut">{d.cap ? fmtFull(d.vMin) : '—'}</span> and rising to a ceiling of{' '}
        <span className="font-bold" id="vMaxOut">{d.cap ? fmtFull(d.vMax) : '—'}</span>, such that the earliest capital admitted is priced most favorably and the last least so.
      </p>

      {/* Figure */}
      <figure className="mb-2 max-w-[620px] mx-auto">
        <div className="fig-frame curve-frame">
          <CurveChart curveState={d.curveState} forceLight={forceLightChart} themeTick={themeTick} />
        </div>
        <figcaption className="text-sm leading-5 t-muted mt-2 italic">Post-money valuation as the round fills. Hover to explore effective price.</figcaption>
      </figure>

      {/* CTA */}
      <div className="mt-10" id="ctaRow">
        <p id="formError" className={`${formError ? '' : 'hidden '}text-sm t-danger mb-3`}>{formError}</p>
        <div className="flex items-center justify-end space-x-4">
          <span className="disabled-tip-wrap">
            <Button id="createBtn" className="py-3 px-8 text-base font-semibold tracking-wide" disabled={disabled || busy} onClick={create}>
              {busy ? 'Creating offering…' : 'Sign and create issuance'}
            </Button>
            <span id="createTip" className="disabled-tip">{tip}</span>
          </span>
        </div>
      </div>
    </>
  );
}

injectChrome();
createRoot(document.getElementById('app')).render(<CreateApp />);
