export function firstOfMonth(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

export function formatMonth(date: string): string {
  return new Intl.DateTimeFormat('en-PK', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${date}T00:00:00`))
}
