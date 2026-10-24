import { expect, type Browser, type Page } from '@playwright/test'

// Every browser context is one anonymous Supabase identity.
export async function newUser(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  return context.newPage()
}

/** Home → mode → create form → event home. Returns the event id from the URL. */
export async function createEvent(page: Page, mode: 'Single Bill' | 'Trip or Event', eventName: string, myName: string): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: mode }).click()
  await page.getByLabel('Event name').fill(eventName)
  await page.getByLabel('Your name').fill(myName)
  await page.getByRole('button', { name: 'Create event' }).click()
  await expect(page.getByRole('heading', { name: 'Let’s add the first expense' })).toBeVisible()
  return eventIdOf(page)
}

export function eventIdOf(page: Page): string {
  const id = new URL(page.url()).hash.match(/^#\/event\/([^/?]+)/)?.[1]
  if (!id) throw new Error(`not on an event page: ${page.url()}`)
  return id
}

/** Opens the invite panel on the event home and reads the link. */
export async function inviteLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Invite friends' }).click()
  const link = await page.getByLabel('Invite link').inputValue()
  expect(link).toMatch(/#\/join\/.+/)
  return link
}

export async function joinEvent(page: Page, link: string, myName: string): Promise<void> {
  await page.goto(link)
  await page.getByLabel('Your name').fill(myName)
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
}

/** From the event home: an equal split between everyone currently in the event. */
export async function addSimpleExpense(page: Page, description: string, amount: string): Promise<void> {
  await page.getByRole('button', { name: 'Add simple expense' }).click()
  await page.getByLabel('Description').fill(description)
  await page.getByLabel('Amount').fill(amount)
  await page.getByRole('button', { name: 'Save expense' }).click()
  await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible()
  await expect(page.locator('.expense-row', { hasText: description })).toBeVisible()
}

export async function goHome(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click()
}

/** Matches an amount as formatted for en (e.g. "RM 30.00", with a no-break space). */
export const rm = (amount: string) => new RegExp(`RM\\s?${amount.replace('.', '\\.')}`)
