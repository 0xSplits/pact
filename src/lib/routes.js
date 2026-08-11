export const createPath = () => '/create';
export const pactPath = pactId => '/pacts/' + encodeURIComponent(pactId);
export const allocationPath = (pactId, allocationId) => `${pactPath(pactId)}/allocations/${encodeURIComponent(allocationId)}`;

export function currentCreatePage() {
  return location.pathname === '/create';
}

export function currentPactId() {
  const match = location.pathname.match(/^\/pacts\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function currentAllocationRoute() {
  const match = location.pathname.match(/^\/pacts\/([^/]+)\/allocations\/([^/]+)\/?$/);
  if (match) {
    return {
      pactId: decodeURIComponent(match[1]),
      allocationId: decodeURIComponent(match[2]),
    };
  }
  return { pactId: null, allocationId: null };
}
