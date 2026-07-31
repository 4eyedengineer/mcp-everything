export const environment = {
  production: true,
  // Same-origin: the k8s ingress (k8s/overlays/homelab) routes /api on this
  // same host straight to the backend Service, so API_BASE (`${apiUrl}/api`)
  // must resolve relative to wherever this bundle is served from rather than
  // a separate API host/port.
  apiUrl: '',
  githubClientId: '', // To be configured from env vars
  enableDevTools: false,
  logLevel: 'error',
  version: '0.1.0',
  buildTimestamp: new Date().toISOString(),
};