import asyncio, json, sys
from playwright.async_api import async_playwright

KEY = sys.argv[1] if len(sys.argv) > 1 else ''
BASE = 'http://127.0.0.1:18900'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1400, 'height': 1000})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))

        await page.goto(BASE + '/')
        await page.evaluate(f"sessionStorage.setItem('ofm-key', {json.dumps(KEY)})")
        await page.reload()
        await page.wait_for_timeout(2500)

        print('TITLE:', (await page.title()).encode('utf-8', 'replace').decode('utf-8'))
        print('MODELS COUNT:', await page.inner_text('#models-count'))
        print('BASEURL:', await page.inner_text('#qs-baseurl'))
        rows = await page.query_selector_all('#models-table tbody tr')
        print('MODEL ROWS:', len(rows))
        # no tab navigation anymore: exactly one visible section
        print('TAB NAV PRESENT:', await page.query_selector('nav') is not None)
        print('DEV OPTIONS COLLAPSED:', not await page.is_visible('#insp-enabled'))
        await page.screenshot(path='shots/01-models.png')

        # open developer options
        await page.click('#dev-options > summary')
        await page.wait_for_timeout(800)
        print('INSPECTOR TOGGLE:', await page.is_checked('#insp-enabled'))
        print('INSPECTOR BODY HIDDEN:', not await page.is_visible('#insp-body'))
        await page.screenshot(path='shots/02-dev-options.png')

        # enable the inspector
        if not await page.is_checked('#insp-enabled'):
            await page.check('#insp-enabled')
            await page.wait_for_timeout(2500)
        print('INSPECTOR BODY VISIBLE AFTER ENABLE:', await page.is_visible('#insp-body'))
        print('REQUESTS COUNT:', await page.inner_text('#requests-count'))
        await page.screenshot(path='shots/03-inspector-on.png')

        # disable again -> buffer cleared, table gone
        await page.uncheck('#insp-enabled')
        await page.wait_for_timeout(2000)
        print('INSPECTOR BODY HIDDEN AFTER DISABLE:', not await page.is_visible('#insp-body'))

        print('CONSOLE LOGS:', logs[:8])
        await browser.close()

asyncio.run(main())
