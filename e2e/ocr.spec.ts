import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { createEvent } from './helpers.ts'

// No retries: a slow or failing OCR run should be seen, not retried away.
test.describe.configure({ retries: 0 })

const RECEIPT = fileURLToPath(new URL('./fixtures/receipt.png', import.meta.url))

// Receipt OCR runs fully in the browser on self-hosted models: no request may leave for a third party.
test('@slow scans a receipt in the browser without contacting third-party origins', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'OCR model download and inference run once, on desktop')
  test.setTimeout(300_000)
  const allowed = new Set([new URL(baseURL!).origin, new URL(process.env.VITE_SUPABASE_URL!).origin])
  const requests: string[] = []
  // Context-level, so requests made by the OCR worker (and its nested worker) are included.
  page.context().on('request', request => requests.push(request.url()))

  await createEvent(page, 'Single Bill', 'Kedai makan', 'Ana')
  await page.getByRole('button', { name: 'Scan a receipt' }).click()
  await expect(page.getByLabel('Split method')).toHaveValue('items')
  await page.getByLabel('Description').fill('Breakfast')
  await page.getByLabel('Choose photo').setInputFiles(RECEIPT)

  await expect(page.getByText('Check the items and prices, then confirm.')).toBeVisible({ timeout: 240_000 })
  await expect(page.getByLabel('Item 1 name')).toHaveValue(/nasi lemak/i)
  await expect(page.getByLabel('Item 1 price')).toHaveValue('12.50')
  await expect(page.getByLabel('Item 2 price')).toHaveValue('3.80')
  await expect(page.getByLabel('Item 3 price')).toHaveValue('4.20')
  await expect(page.getByLabel('Item 4 name')).toHaveCount(0) // TOTAL is not an item

  await page.getByRole('button', { name: 'Confirm items' }).click()
  await page.getByRole('button', { name: 'Save expense' }).click()
  await expect(page.locator('.expense-row', { hasText: 'Breakfast' })).toContainText(/RM\s?20\.50/)

  expect(requests.some(url => url.includes('/ocr-models/'))).toBe(true)
  const foreign = requests.filter(url => /^https?:/.test(url) && !allowed.has(new URL(url).origin))
  expect(foreign).toEqual([])
})
