// Which wallets may manage a PACT. Shared by the server (list filtering)
// and the status page (issuer-view gating). This is UI-level gating, not
// signature authentication — see the limitations section in the README.
export function pactWallets(pact) {
  return [pact && pact.issuerWallet, pact && pact.proceedsAddress]
    .filter(Boolean)
    .map(wallet => String(wallet).toLowerCase());
}

export function canAccessPact(pact, wallet) {
  return pactWallets(pact).includes(String(wallet || '').toLowerCase());
}
