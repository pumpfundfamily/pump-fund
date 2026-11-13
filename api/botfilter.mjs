/**
 * Mentions from accounts that look automated are dropped SILENTLY (operator 10 Nov): no launch, no reply. A reply to a
 * bot invites a reply loop and reads as spam to X. Each signal is cheap (fields already on the mention, no extra calls).
 * A blue-verified account is never treated as a bot by the softer signals, only by X's own "automated" label.
 * Returns a short reason (for the log) or null.
 */
export function botReason(m, now = Math.floor(Date.now() / 1000)) {
  if (m.authorAutomated) return 'labelled automated by X'
  if (m.authorVerified) return null
  const followers = m.authorFollowers ?? 0
  const ageDays = m.authorCreatedAt ? Math.max(1, (now - m.authorCreatedAt) / 86400) : null
  if (/default_profile_images/.test(m.authorAvatar ?? '') && followers < 500) return 'default profile picture'
  if (/\d{6,}$/.test(m.authorHandle ?? '') && followers < 500) return 'auto-generated handle'
  if (m.authorFollowing != null && m.authorFollowing > 1000 && m.authorFollowing > 20 * Math.max(1, followers)) return 'follows far more than follow it'
  if (m.authorTweets != null && ageDays && m.authorTweets / ageDays > 250) return 'posts hundreds of times a day'
  return null
}
