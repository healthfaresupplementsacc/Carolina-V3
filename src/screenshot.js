'use strict';
/**
 * EOD screenshot module.
 * Uses Puppeteer to render a slim mobile-friendly summary and capture a PNG.
 */

const path = require('path');
const fs = require('fs');
const config = require('./config');

const ARCHIVE_DIR = path.join(process.cwd(), 'public', 'archive');

async function takeScreenshot(date) {
  let browser;
  try {
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch (e) {
      console.warn('[Screenshot] Puppeteer not available, skipping screenshot');
      return null;
    }

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

    const url = `${config.app.publicUrl}/eod-summary?date=${date}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForTimeout(2000); // Let animations settle

    // Ensure archive directory exists
    if (!fs.existsSync(ARCHIVE_DIR)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    }

    const filename = `${date}.png`;
    const filepath = path.join(ARCHIVE_DIR, filename);

    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`[Screenshot] Saved: ${filepath}`);

    return { filepath, filename, url: `/archive/${filename}` };
  } catch (err) {
    console.error('[Screenshot] Error:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { takeScreenshot, ARCHIVE_DIR };
