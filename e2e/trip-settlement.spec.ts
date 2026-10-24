import { expect, test } from '@playwright/test'
import { addSimpleExpense, createEvent, goHome, inviteLink, joinEvent, newUser, rm } from './helpers.ts'

test.describe('plan happy path', () => {
  // The create form also asks for "Your name"; a returning user has it prefilled from an earlier event.
  // Seed that preference so the plan's test runs exactly as written.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem('preferredName')) localStorage.setItem('preferredName', 'Ana')
    })
  })

  test('creates a trip, adds mixed expenses, and previews optimized settlement', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Trip or Event' }).click()
    await page.getByLabel('Event name').fill('Penang Trip')
    await page.getByRole('button', { name: 'Create event' }).click()
    await page.getByRole('button', { name: 'Add simple expense' }).click()
    await page.getByLabel('Description').fill('Petrol')
    await page.getByLabel('Amount').fill('90.00')
    await page.getByRole('button', { name: 'Save expense' }).click()
    await page.getByRole('button', { name: 'Settle now' }).click()
    await expect(page.getByText('Optimized direct settlement')).toBeVisible()
  })
})

test('two friends split a trip, settle with the optimized plan, and complete the payment', async ({ browser }) => {
  test.setTimeout(120_000)
  const owner = await newUser(browser)
  const ben = await newUser(browser)

  await createEvent(owner, 'Trip or Event', 'Penang Trip', 'Ana')
  const link = await inviteLink(owner)

  // Owner watches the People page while Ben joins: realtime must list him without a reload.
  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'People' }).click()
  const people = owner.getByRole('list', { name: 'Event members' })
  await expect(people.getByRole('listitem')).toHaveCount(1)
  await joinEvent(ben, link, 'Ben')
  await expect(people.getByRole('listitem').filter({ hasText: 'Ben' })).toBeVisible({ timeout: 15_000 })
  await expect(people.getByRole('listitem').filter({ hasText: 'Ben' })).toContainText('Participant')

  // Petrol RM 90 paid by Ana, Lunch RM 30 paid by Ben, both split equally → Ben owes 45 − 15 = 30.
  await goHome(owner)
  await addSimpleExpense(owner, 'Petrol', '90.00')
  await addSimpleExpense(ben, 'Lunch', '30.00')

  await goHome(owner)
  await expect(owner.locator('.expense-row', { hasText: 'Lunch' })).toBeVisible({ timeout: 15_000 })
  await owner.getByRole('button', { name: 'Settle now' }).click()

  const cards = owner.getByRole('radiogroup', { name: 'Settlement method' }).getByRole('article')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toContainText('Pay original payers')
  await expect(cards.nth(1)).toContainText('Optimized direct settlement')
  await expect(cards.nth(1)).toContainText('Recommended')
  await expect(cards.nth(2)).toContainText('Settlement coordinator')
  await expect(cards.nth(0)).not.toContainText('Recommended')
  await expect(cards.nth(2)).not.toContainText('Recommended')
  await expect(owner.getByRole('radio', { name: /Optimized direct settlement/ })).toBeChecked()
  await expect(cards.nth(1)).toContainText(rm('30.00'))

  await owner.locator('.settlement__footer').getByRole('button', { name: 'Settle now' }).click()
  const dialog = owner.getByRole('dialog', { name: 'Settle this event?' })
  await expect(dialog).toContainText('Method: Optimized direct settlement')
  await dialog.getByRole('button', { name: 'Confirm and settle' }).click()

  await expect(owner.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible()
  const ownerRow = owner.getByRole('listitem').filter({ hasText: 'Ben pays you' })
  await expect(ownerRow).toContainText(rm('30.00'))
  await expect(ownerRow).toContainText('Pending')

  // The receiver adds bank details before Ben pays.
  await owner.getByRole('button', { name: 'Add receiving details' }).click()
  await owner.getByLabel('Bank name').fill('Maybank')
  await owner.getByLabel('Account holder name').fill('Ana Lim')
  await owner.getByLabel('Account number').fill('1234567890')
  await owner.getByRole('button', { name: 'Save details' }).click()
  await expect(owner.getByText('Saved.')).toBeVisible()

  // Ben's event home switches to the payment phase through realtime.
  await ben.getByRole('button', { name: 'View payments' }).click({ timeout: 15_000 })
  const benRow = ben.getByRole('listitem').filter({ hasText: /Pay RM\s?30\.00 to Ana/ })
  await expect(benRow).toContainText(/Pay RM\s?30\.00 to Ana/)
  await benRow.getByRole('button', { name: 'Show payment details' }).click()
  await expect(benRow).toContainText('Maybank')
  await expect(benRow).toContainText('1234567890')
  await benRow.getByRole('button', { name: "I've sent the payment" }).click()
  await expect(benRow).toContainText('Sent')

  await expect(ownerRow.getByRole('button', { name: 'Payment received' })).toBeVisible({ timeout: 15_000 })
  await ownerRow.getByRole('button', { name: 'Payment received' }).click()
  await expect(ownerRow).toContainText('Received')
  await expect(benRow).toContainText('Received', { timeout: 15_000 })
  // Details are dropped once the payment is received.
  await expect(benRow).not.toContainText('1234567890')

  await owner.context().close()
  await ben.context().close()
})
