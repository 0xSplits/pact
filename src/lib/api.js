async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'Request failed.');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const PactAPI = {
  createPact(data) {
    return request('/api/pacts', { method: 'POST', body: JSON.stringify(data) });
  },
  getPact(id) {
    return request('/api/pacts/' + encodeURIComponent(id));
  },
  listPacts(wallet) {
    return request('/api/pacts?wallet=' + encodeURIComponent(wallet));
  },
  listPurchases(wallet) {
    return request('/api/purchases?wallet=' + encodeURIComponent(wallet));
  },
  getLiquidSplitHolders(address, chainId) {
    const query = chainId ? '?chainId=' + encodeURIComponent(chainId) : '';
    return request('/api/liquid-splits/' + encodeURIComponent(address) + '/holders' + query);
  },
  syncOfferingState(pactId, state) {
    return request('/api/pacts/' + encodeURIComponent(pactId) + '/offering-state', {
      method: 'POST',
      body: JSON.stringify(state),
    });
  },
  syncCapTableState(pactId, state) {
    return request('/api/pacts/' + encodeURIComponent(pactId) + '/cap-table-state', {
      method: 'POST',
      body: JSON.stringify(state),
    });
  },
  addAllocation(pactId, allocation) {
    return request('/api/pacts/' + encodeURIComponent(pactId) + '/allocations', {
      method: 'POST',
      body: JSON.stringify(allocation),
    });
  },
  deleteAllocation(pactId, allocationId) {
    return request('/api/pacts/' + encodeURIComponent(pactId) + '/allocations/' + encodeURIComponent(allocationId), {
      method: 'DELETE',
    });
  },
  fundAllocation(pactId, allocationId, buyerWallet, purchase = {}) {
    return request('/api/pacts/' + encodeURIComponent(pactId) + '/allocations/' + encodeURIComponent(allocationId) + '/fund', {
      method: 'POST',
      body: JSON.stringify({ buyerWallet, ...purchase }),
    });
  },
};
