export function readPreferredName(): string {
  try {
    return localStorage.getItem('preferredName') ?? ''
  } catch {
    return ''
  }
}
