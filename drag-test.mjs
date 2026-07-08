// Standalone drag-select test against the running Vite dev server.
// Runs in WebKit (same engine as Tauri on macOS) and Chromium.
import { webkit, chromium } from 'playwright'

const makeVideos = (n) => Array.from({ length: n }, (_, i) => ({
  id: `test-${i}`,
  path: `/tmp/fake-${i}.mp4`,
  filename: `test-video-${String(i).padStart(2, '0')}.mp4`,
  folder: '/tmp',
  size_bytes: 1000,
  duration_secs: 60,
  width: 1280,
  height: 720,
  fps: 30,
  codec: 'h264',
  thumbnail_path: null,
  created_at: null,
  modified_at: null,
  indexed_at: '2026-01-01T00:00:00Z',
  play_count: 0,
  last_played_at: null,
  tags: [],
}))

const fakeVideos = Array.from({ length: 8 }, (_, i) => ({
  id: `test-${i}`,
  path: `/tmp/fake-${i}.mp4`,
  filename: `test-video-${i}.mp4`,
  folder: '/tmp',
  size_bytes: 1000,
  duration_secs: 60,
  width: 1280,
  height: 720,
  fps: 30,
  codec: 'h264',
  thumbnail_path: null,
  created_at: null,
  modified_at: null,
  indexed_at: '2026-01-01T00:00:00Z',
  play_count: 0,
  last_played_at: null,
  tags: [],
}))

async function testEngine(name, engine) {
  const browser = await engine.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.log(`[${name}] pageerror:`, err.message))

  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500) // let React mount (bootstrap invoke will fail — fine)

  // Inject fake videos into the app's Zustand store (exposed on window in dev)
  await page.waitForFunction(() => !!window.__store, { timeout: 10000 })
  await page.evaluate((videos) => {
    window.__store.getState().setVideos(videos)
  }, fakeVideos)
  await page.waitForTimeout(500)

  const cardCount = await page.locator('[data-video-id]').count()
  if (cardCount === 0) throw new Error(`[${name}] no video cards rendered`)

  // Compute a rectangle that covers the first ~4 cards
  const first = await page.locator('[data-video-id]').first().boundingBox()
  const fourth = await page.locator('[data-video-id]').nth(3).boundingBox()

  // Start drag from an empty spot: just below the last row of cards
  const last = await page.locator('[data-video-id]').last().boundingBox()
  const startX = first.x - 8   // slightly left of the first card (padding area)
  const startY = first.y - 8   // slightly above (toolbar margin/padding)
  const endX = fourth.x + fourth.width + 4
  const endY = fourth.y + fourth.height + 4

  // Perform drag with real pointer events
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 })
  await page.mouse.move(endX, endY, { steps: 5 })
  await page.mouse.up()   // release INSIDE the window — the failing case
  await page.waitForTimeout(300)

  const selectedCount = await page.evaluate(() => window.__store.getState().selectedVideoIds.size)

  // Also verify selection survives (no late click clears it)
  await page.waitForTimeout(500)
  const selectedAfterWait = await page.evaluate(() => window.__store.getState().selectedVideoIds.size)

  console.log(`[${name}] cards=${cardCount} selected=${selectedCount} afterWait=${selectedAfterWait}`)
  if (selectedCount < 2) throw new Error(`[${name}] FAIL: expected >=2 selected, got ${selectedCount}`)
  if (selectedAfterWait !== selectedCount) throw new Error(`[${name}] FAIL: selection was cleared after drag (${selectedCount} -> ${selectedAfterWait})`)

  // ── Scenario 2: release the drag ON TOP of a card ──
  await page.evaluate(() => window.__store.getState().clearSelection())
  const secondCard = await page.locator('[data-video-id]').nth(1).boundingBox()
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // End in the middle of the second card
  await page.mouse.move(secondCard.x + secondCard.width / 2, secondCard.y + secondCard.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(400)

  const s2 = await page.evaluate(() => ({
    selected: window.__store.getState().selectedVideoIds.size,
    playing: window.__store.getState().currentVideo !== null,
  }))
  console.log(`[${name}] release-on-card: selected=${s2.selected} playbackTriggered=${s2.playing}`)
  if (s2.selected < 1) throw new Error(`[${name}] FAIL: release-on-card selected nothing`)
  if (s2.playing) throw new Error(`[${name}] FAIL: release-on-card triggered playback`)

  // ── Scenario 3: drag with auto-scroll — select videos beyond the fold ──
  const many = 60
  await page.evaluate((videos) => {
    window.__store.getState().clearSelection()
    window.__store.getState().setVideos(videos)
  }, makeVideos(many))
  await page.waitForTimeout(500)

  // Ensure the grid is actually scrollable and scrolled to the top
  const gridInfo = await page.evaluate(() => {
    const cards = document.querySelectorAll('[data-video-id]')
    const container = cards[0]?.closest('.overflow-y-auto')
    if (container) container.scrollTop = 0
    return {
      cards: cards.length,
      scrollable: container ? container.scrollHeight > container.clientHeight : false,
    }
  })
  if (!gridInfo.scrollable) throw new Error(`[${name}] test setup issue: grid not scrollable with ${gridInfo.cards} cards`)

  const firstBox = await page.locator('[data-video-id]').first().boundingBox()

  // Get the scroll container's actual bounds so we hold inside the 48px edge zone
  const contBounds = await page.evaluate(() => {
    const container = document.querySelector('[data-video-id]').closest('.overflow-y-auto')
    const r = container.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  })

  // Start above the first card, drag to the bottom edge and HOLD to auto-scroll
  await page.mouse.move(firstBox.x - 8, firstBox.y - 8)
  await page.mouse.down()
  await page.mouse.move(contBounds.right - 100, contBounds.bottom - 15, { steps: 10 })
  // Hold inside the bottom edge zone — the rAF auto-scroll loop should kick in
  await page.waitForTimeout(3000)
  await page.mouse.up()
  await page.waitForTimeout(300)

  const s3 = await page.evaluate(() => window.__store.getState().selectedVideoIds.size)
  console.log(`[${name}] autoscroll-drag: selected=${s3} of ${many}`)
  // The drag started above card 0 and auto-scrolled for 2.5s — it must have
  // selected far more than the ~15 cards initially visible in the viewport.
  if (s3 < 25) throw new Error(`[${name}] FAIL: autoscroll drag only selected ${s3} (expected >=25 — off-screen cards were lost)`)

  await browser.close()
  console.log(`[${name}] PASS`)
}

try {
  await testEngine('webkit', webkit)
  await testEngine('chromium', chromium)
  console.log('ALL TESTS PASSED')
  process.exit(0)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
