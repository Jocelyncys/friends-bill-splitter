// Distinguishes members who share a display name: "Ali (1)", "Ali (2)" (in join order).
// Unique names are left as they are.
export function displayNames(members: Array<{ userId: string; displayName: string }>): Map<string, string> {
  const key = (name: string) => name.trim().toLowerCase()
  const totals = new Map<string, number>()
  for (const m of members) totals.set(key(m.displayName), (totals.get(key(m.displayName)) ?? 0) + 1)
  const seen = new Map<string, number>()
  return new Map(
    members.map(m => {
      const k = key(m.displayName)
      const n = (seen.get(k) ?? 0) + 1
      seen.set(k, n)
      const name = m.displayName.trim()
      return [m.userId, (totals.get(k) ?? 0) > 1 ? `${name} (${n})` : name] as const
    }),
  )
}
