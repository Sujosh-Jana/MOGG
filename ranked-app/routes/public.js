const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getLocalizedPricing } = require('../services/pricing');
const { extractText } = require('../services/ocr');
const { parseReceiptWithAI } = require('../services/ai');
const { chooseDisplayCurrency, convertAmount, detectCurrencyFromText, roundMoney } = require('../services/currency');
const { estimateDeductibility } = require('../services/deductibility');
const { findWorkspaceByIngestToken, getMonthlyCount, getUserTier, saveReceipt } = require('../services/db');
const { getPlanLimit, getUpgradeTarget, isUploadBlocked, normalizeTier } = require('../services/plans');
const { isEmailIngestEnabled } = require('../services/security');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const pricingLimiter = createRateLimiter({ name: 'pricing', windowMs: 60_000, max: 120 });
const ingestLimiter = createRateLimiter({ name: 'email ingest', windowMs: 10 * 60_000, max: 20 });

router.get('/pricing', pricingLimiter, async (req, res, next) => {
  try {
    const payload = await getLocalizedPricing(req.query.currency || 'USD');
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post('/ingest/email', ingestLimiter, async (req, res, next) => {
  if (!isEmailIngestEnabled()) {
    return res.status(404).json({ error: 'Email ingest is not enabled for this deployment.' });
  }

  const token = String(req.headers['x-ingest-token'] || req.body?.token || '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Missing ingest token' });
  }

  try {
    const workspace = await findWorkspaceByIngestToken(token);
    if (!workspace) {
      return res.status(401).json({ error: 'Invalid ingest token' });
    }

    const payload = req.body || {};
    const fromEmail = String(payload.from || '').trim().toLowerCase();
    const subject = String(payload.subject || '').trim();
    const textBody = String(payload.text || payload.body || '').trim();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 10) : [];
    const processed = [];
    const tier = normalizeTier(await getUserTier(workspace.owner_uid));
    const planLimit = getPlanLimit(tier);
    let monthlyCount = await getMonthlyCount(workspace.owner_uid);

    if (isUploadBlocked(tier, monthlyCount)) {
      const nextPlan = getUpgradeTarget(tier);
      return res.status(402).json({
        error: `Workspace upload limit reached for the ${tier} plan. Upgrade to ${nextPlan} to keep ingesting receipts.`,
        upgrade_required: true,
        current_tier: tier,
        next_plan: nextPlan,
        limit: Number.isFinite(planLimit) ? planLimit : null,
      });
    }

    for (const attachment of attachments) {
      if (isUploadBlocked(tier, monthlyCount)) break;
      const fileName = String(attachment.filename || attachment.name || `email-${uuidv4()}.bin`);
      const mimeType = String(attachment.content_type || attachment.mimetype || '').toLowerCase();
      const base64 = String(attachment.content_base64 || attachment.base64 || '').trim();
      if (!base64 || !ALLOWED_TYPES.has(mimeType)) continue;

      const tempPath = path.join(require('os').tmpdir(), 'receiptly-uploads', `${uuidv4()}${path.extname(fileName) || ''}`);

      try {
        fs.writeFileSync(tempPath, Buffer.from(base64, 'base64'));
        const rawText = await extractText(tempPath, mimeType);
        const receipt = await buildEmailReceipt({
          rawText: [subject, textBody, rawText].filter(Boolean).join('\n\n'),
          fileName,
          mimeType,
          ownerUid: workspace.owner_uid,
          ownerProfile: workspace.profile,
          sourceEmail: fromEmail,
        });
        const id = await saveReceipt(workspace.owner_uid, receipt, fileName, {
          created_by_uid: 'email_ingest',
          created_by_email: fromEmail,
        });
        processed.push({ id, vendor: receipt.vendor, amount: receipt.display_amount, currency: receipt.display_currency, source: fileName });
        monthlyCount += 1;
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    }

    if (!processed.length && textBody && !isUploadBlocked(tier, monthlyCount)) {
      const receipt = await buildEmailReceipt({
        rawText: [subject, textBody].filter(Boolean).join('\n\n'),
        fileName: subject || 'forwarded-email.txt',
        mimeType: 'text/plain',
        ownerUid: workspace.owner_uid,
        ownerProfile: workspace.profile,
        sourceEmail: fromEmail,
      });
      const id = await saveReceipt(workspace.owner_uid, receipt, subject || 'forwarded-email.txt', {
        created_by_uid: 'email_ingest',
        created_by_email: fromEmail,
      });
      processed.push({ id, vendor: receipt.vendor, amount: receipt.display_amount, currency: receipt.display_currency, source: 'email-body' });
      monthlyCount += 1;
    }

    if (!processed.length) {
      return res.status(400).json({ error: 'No supported receipt content found. Send text or supported attachments.' });
    }

    res.status(201).json({
      message: `Processed ${processed.length} receipt${processed.length === 1 ? '' : 's'} from email.`,
      processed,
    });
  } catch (err) {
    next(err);
  }
});

async function buildEmailReceipt({ rawText, fileName, ownerProfile, sourceEmail }) {
  const structured = await parseReceiptWithAI(rawText);
  const originalCurrency = structured.original_currency || detectCurrencyFromText(rawText) || 'USD';
  const displayCurrency = chooseDisplayCurrency(ownerProfile.preferred_currency || 'USD', originalCurrency);
  const converted = await convertAmount(structured.original_amount, originalCurrency, displayCurrency);

  const receipt = {
    ...structured,
    original_currency: originalCurrency,
    display_currency: displayCurrency,
    display_amount: roundMoney(converted?.amount ?? structured.original_amount),
    fx_rate: converted?.rate ?? (displayCurrency === originalCurrency ? 1 : null),
    fx_source: converted?.source ?? (displayCurrency === originalCurrency ? 'identity' : null),
    original_filename: fileName,
    ocr_text_preview: rawText.slice(0, 500),
    notes: [structured.notes, sourceEmail ? `Forwarded by ${sourceEmail}` : null].filter(Boolean).join(' | '),
    tax_country: ownerProfile.tax_country || 'GLOBAL',
  };

  receipt.deductibility = estimateDeductibility(receipt, { tax_country: ownerProfile.tax_country || 'GLOBAL' });
  receipt.review_status = receipt.deductibility.review_required || receipt.confidence === 'low' ? 'needs_review' : 'approved';
  return receipt;
}

module.exports = router;
