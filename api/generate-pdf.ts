import type { VercelRequest, VercelResponse } from '@vercel/node';
import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';

// Vercel sets this env var automatically on the paid tiers.
// On hobby/free, maxDuration is limited to 10s — bump in vercel.json.
export const config = {
  maxDuration: 60,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { html, filename } = req.body as { html?: string; filename?: string };

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing html in request body' });
  }

  const safeFilename = (filename ?? 'PercIQ-report')
    .replace(/[^a-z0-9\-_.]/gi, '-')
    .replace(/\.pdf$/i, '') + '.pdf';

  let browser;
  try {
    // @sparticuz/chromium-min downloads the binary on first cold start.
    // CHROMIUM_REMOTE_EXECUTABLE_PATH can override with a pre-downloaded binary.
    const executablePath = process.env.CHROMIUM_REMOTE_EXECUTABLE_PATH
      || await chromium.executablePath(
          'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar'
        );

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 816, height: 1056 },
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();

    // Raise request size limit for the base64 map image embedded in the HTML.
    await page.setDefaultNavigationTimeout(30000);

    // setContent with waitUntil networkidle0 ensures web fonts and any linked
    // resources resolve before we print. The HTML is fully self-contained
    // (base64 images, inline CSS, Google Fonts <link>) so this is fast.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    const pdfBuffer = await page.pdf({
      format: 'letter',
      printBackground: true,
      preferCSSPageSize: true,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('[generate-pdf] error:', err);
    return res.status(500).json({ error: 'PDF generation failed' });
  } finally {
    if (browser) await browser.close();
  }
}
