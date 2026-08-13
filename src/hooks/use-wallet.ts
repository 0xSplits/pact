import { useEffect, useRef, useState } from 'react';
import { PactWallet } from '../lib/chain/wallet.ts';

// Connects the shared wallet widget to React state. Returns the connected
// account (or null), updating whenever the user connects, switches, or
// disconnects.
export function useWallet({ onError }: { onError?: (err: unknown) => void } = {}): string | null {
  const [account, setAccount] = useState<string | null>(PactWallet.account);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    PactWallet.init({
      buttonId: 'walletToggle',
      onChange: setAccount,
      onError: err => onErrorRef.current && onErrorRef.current(err),
    });
  }, []);

  return account;
}
