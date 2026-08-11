import { useCallback, useEffect, useRef, useState } from 'react';
import { getOfferingState } from './onchain.js';

const POLL_MS = 15000;

// Live offering snapshot: loads immediately, then re-reads the contract on an
// interval while the tab is visible and whenever the window regains focus, so
// other buyers' purchases show up without a manual reload. Background polls
// update silently — the last good snapshot stays on screen while a refresh is
// in flight, and a failed poll never replaces loaded data with an error.
//
// Returns { offering, refresh }:
//   offering: null | { status: 'loading' } | { status: 'loaded', ...state } | { status: 'error', error }
export function useOfferingState({ offeringAddress, buyer, onLoaded } = {}) {
  const [offering, setOffering] = useState(null);
  const offeringRef = useRef(null);
  const generationRef = useRef(0);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const set = state => {
    offeringRef.current = state;
    setOffering(state);
  };

  const refresh = useCallback(async () => {
    if (!offeringAddress) return;
    const generation = ++generationRef.current;
    const previous = offeringRef.current;
    if (!previous || previous.status !== 'loaded') set({ status: 'loading' });
    try {
      const state = await getOfferingState({ offeringAddress, buyer: buyer || undefined });
      if (generation !== generationRef.current) return;
      set({ status: 'loaded', ...state });
      if (onLoadedRef.current) onLoadedRef.current(state);
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (!previous || previous.status !== 'loaded') {
        set({ status: 'error', error: err.message || 'Could not read onchain offering state.' });
      }
    }
  }, [offeringAddress, buyer]);

  useEffect(() => {
    generationRef.current++;
    set(null);
    if (!offeringAddress) return;
    refresh();
    const tick = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const interval = setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh, offeringAddress]);

  return { offering, refresh };
}
