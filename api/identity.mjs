/** X handles as people paste them: `@name`, `x.com/name`, `twitter.com/name/status/…`. Display only: identity is the X id. */
export function cleanHandle(handle) {
  return String(handle ?? '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/\/.*$/, '')
}
