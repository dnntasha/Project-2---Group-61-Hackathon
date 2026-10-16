// Response headers that switch off risky browser behaviour. Everything the API
// returns is JSON or an uploaded image, none of which should be sniffed as
// something else, framed by another site, or leak this site's URLs.
export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
}
