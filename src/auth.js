// src/auth.js
//
// Shared-secret bearer auth. Loopback-only daemon, so this is a "which local
// process are you" gate, not a "who's the user" gate. User identity (G vs.
// non-G) is decided upstream by OpenClaw's bindings + channel auth.

export function checkBearer(req, expected) {
  if (!expected) return true; // empty expected = auth disabled (dev/test)
  const hdr = req.headers['authorization'] || req.headers['Authorization'];
  if (!hdr || typeof hdr !== 'string') return false;
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1] === expected;
}
