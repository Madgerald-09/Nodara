export function formatMinorAmount(amountMinor: number, currency: string) {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amountMinor / (10 ** digits))
}

export function buildSafeCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const cell = (value: string | number | null | undefined) => {
    let text = value == null ? '' : String(value)
    if (/^[=+@-]/.test(text.trimStart())) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  return `\uFEFF${[headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n')}`
}

export function downloadCsv(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
