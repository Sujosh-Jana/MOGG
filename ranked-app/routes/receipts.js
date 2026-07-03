const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { extractText } = require('../services/ocr');
const { parseReceiptWithAI } = require('../services/ai');
const {
  saveReceipt,
  getUserReceipts,
  deleteReceipt,
  getMonthlyCount,
  getUserTier,
  getSettingsProfile,
  getWorkspaceAccess,
  updateReceiptDetails,
  updateReceiptReview,
  ensureUserProfile,
} = require('../services/db');
const { chooseDisplayCurrency, convertAmount, detectCurrencyFromText, roundMoney } = require('../services/currency');
const { estimateDeductibility } = require('../services/deductibility');
const { getPlanLimit, getUpgradeTarget, isUploadBlocked, normalizeTier } = require('../services/plans');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

const storage = multer.diskStorage({
  destination: path.join(require('os').tmpdir(), 'receiptly-uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Use JPEG, PNG, WEBP, HEIC, or PDF.`));
    }
  },
});
const uploadLimiter = createRateLimiter({
  name: 'receipt upload',
  windowMs: 15 * 60_000,
  max: 30,
  keyGenerator: (req) => req.user?.uid || req.ip || 'anonymous',
});
const reviewLimiter = createRateLimiter({
  name: 'receipt review',
  windowMs: 5 * 60_000,
  max: 120,
  keyGenerator: (req) => req.user?.uid || req.ip || 'anonymous',
});

router.post('/upload', uploadLimiter, upload.single('receipt'), async (req, res, next) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    await ensureUserProfile(req.user.uid, req.user.email || '');
    const access = await getWorkspaceAccess(req.user.uid, req.user.email || '');
    const workspaceUid = access.owner_uid;
    const tier = normalizeTier(await getUserTier(workspaceUid));
    const count = await getMonthlyCount(workspaceUid);
    const planLimit = getPlanLimit(tier);
    if (isUploadBlocked(tier, count)) {
      const nextPlan = getUpgradeTarget(tier);
      const readableLimit = Number.isFinite(planLimit) ? `${planLimit}/month` : 'your current plan';
      return res.status(402).json({
        error: `${tier.charAt(0).toUpperCase() + tier.slice(1)} plan limit reached (${readableLimit}). Upgrade to ${nextPlan.charAt(0).toUpperCase() + nextPlan.slice(1)} to keep uploading receipts.`,
        upgrade_required: true,
        current_tier: tier,
        next_plan: nextPlan,
        limit: Number.isFinite(planLimit) ? planLimit : null,
      });
    }

    const rawText = await extractText(file.path, file.mimetype);
    const structured = await parseReceiptWithAI(rawText);
    const settings = await getSettingsProfile(req.user.uid, req.user.email || '');
    const originalCurrency = structured.original_currency || detectCurrencyFromText(rawText) || 'USD';
    const displayCurrency = chooseDisplayCurrency(settings.preferred_currency, originalCurrency);
    const converted = await convertAmount(structured.original_amount, originalCurrency, displayCurrency);

    const enriched = {
      ...structured,
      original_currency: originalCurrency,
      display_currency: displayCurrency,
      display_amount: roundMoney(converted?.amount ?? structured.original_amount),
      fx_rate: converted?.rate ?? (displayCurrency === originalCurrency ? 1 : null),
      fx_source: converted?.source ?? (displayCurrency === originalCurrency ? 'identity' : null),
      ocr_text_preview: rawText.slice(0, 500),
      tax_country: settings.tax_country || 'GLOBAL',
    };
    enriched.deductibility = estimateDeductibility(enriched, { tax_country: settings.tax_country });
    enriched.review_status = enriched.deductibility.review_required || enriched.confidence === 'low' ? 'needs_review' : 'approved';

    const receiptId = await saveReceipt(workspaceUid, enriched, file.originalname, {
      created_by_uid: req.user.uid,
      created_by_email: req.user.email || '',
    });

    res.status(201).json({
      id: receiptId,
      ...enriched,
      message: 'Receipt processed successfully',
    });
  } catch (err) {
    next(err);
  } finally {
    if (file?.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
});

router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.year && req.query.month) {
      filter.year = parseInt(req.query.year, 10);
      filter.month = parseInt(req.query.month, 10);
    }
    if (req.query.search) filter.search = String(req.query.search);
    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.review_status) filter.review_status = String(req.query.review_status);
    if (req.query.duplicates_only === '1') filter.duplicates_only = true;

    await ensureUserProfile(req.user.uid, req.user.email || '');
    const access = await getWorkspaceAccess(req.user.uid, req.user.email || '');
    const settings = await getSettingsProfile(req.user.uid, req.user.email || '');
    const receipts = await getUserReceipts(access.owner_uid, filter, settings.preferred_currency || 'USD', {
      tax_country: settings.tax_country || 'GLOBAL',
    });

    const total = receipts.reduce((sum, r) => sum + (r.display_amount || r.original_amount || 0), 0);
    const deductibleTotal = receipts.reduce((sum, r) => sum + Number(r.deductibility?.amount || 0), 0);
    const deductibleReviewCount = receipts.filter((r) => r.deductibility?.review_required).length;
    const duplicateCount = receipts.filter((r) => r.duplicate_status === 'possible_duplicate').length;
    const approvedCount = receipts.filter((r) => r.review_status === 'approved').length;
    const pendingCount = receipts.filter((r) => r.review_status === 'pending').length;
    const needsReviewCount = receipts.filter((r) => r.review_status === 'needs_review').length;
    const byCategory = receipts.reduce((acc, r) => {
      acc[r.category] = (acc[r.category] || 0) + (r.display_amount || r.original_amount || 0);
      return acc;
    }, {});
    const byVendor = receipts.reduce((acc, r) => {
      const vendor = r.vendor || 'Unknown';
      acc[vendor] = (acc[vendor] || 0) + (r.display_amount || r.original_amount || 0);
      return acc;
    }, {});
    const topVendors = Object.entries(byVendor)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([vendor, amount]) => ({ vendor, amount: Math.round(amount * 100) / 100 }));

    res.json({
      receipts,
      profile: {
        tier: settings.tier || 'free',
        preferred_currency: settings.preferred_currency || 'USD',
        billing_status: settings.billing_status || 'inactive',
        tax_country: settings.tax_country || 'GLOBAL',
        business_name: settings.business_name || '',
        export_brand_name: settings.export_brand_name || '',
        default_client_name: settings.default_client_name || '',
        team_member_emails: settings.team_member_emails || [],
        ingest_email_address: settings.ingest_email_address || null,
        is_workspace_owner: settings.is_workspace_owner,
      },
      summary: {
        count: receipts.length,
        total: Math.round(total * 100) / 100,
        deductible_total: Math.round(deductibleTotal * 100) / 100,
        deductible_review_count: deductibleReviewCount,
        duplicate_count: duplicateCount,
        approved_count: approvedCount,
        pending_count: pendingCount,
        needs_review_count: needsReviewCount,
        by_category: byCategory,
        top_vendors: topVendors,
        currency: settings.preferred_currency || 'USD',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', reviewLimiter, async (req, res, next) => {
  try {
    const access = await getWorkspaceAccess(req.user.uid, req.user.email || '');
    const settings = await getSettingsProfile(req.user.uid, req.user.email || '');
    const receipt = await updateReceiptDetails(access.owner_uid, req.params.id, req.body || {}, {
      uid: req.user.uid,
      email: req.user.email || '',
      preferred_currency: settings.preferred_currency || 'USD',
      tax_country: settings.tax_country || 'GLOBAL',
    });
    res.json({ receipt, message: 'Receipt updated' });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/review', reviewLimiter, async (req, res, next) => {
  try {
    const access = await getWorkspaceAccess(req.user.uid, req.user.email || '');
    const settings = await getSettingsProfile(req.user.uid, req.user.email || '');
    const receipt = await updateReceiptReview(access.owner_uid, req.params.id, req.body || {}, {
      uid: req.user.uid,
      email: req.user.email || '',
      preferred_currency: settings.preferred_currency || 'USD',
      tax_country: settings.tax_country || 'GLOBAL',
    });
    res.json({ receipt, message: 'Receipt review updated' });
  } catch (err) {
    next(err);
  }
});

router.post('/review/bulk', reviewLimiter, async (req, res, next) => {
  try {
    const access = await getWorkspaceAccess(req.user.uid, req.user.email || '');
    const settings = await getSettingsProfile(req.user.uid, req.user.email || '');
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => String(id)).filter(Boolean).slice(0, 100) : [];
    const reviewStatus = String(req.body?.review_status || '');
    if (!ids.length) {
      throw Object.assign(new Error('No receipt ids provided for bulk review'), { status: 400 });
    }
    if (!['approved', 'needs_review', 'pending'].includes(reviewStatus)) {
      throw Object.assign(new Error('Unsupported bulk review status'), { status: 400 });
    }

    const updated = [];
    for (const id of ids) {
      const receipt = await updateReceiptReview(access.owner_uid, id, {
        review_status: reviewStatus,
        approval_notes: req.body?.approval_notes || '',
      }, {
        uid: req.user.uid,
        email: req.user.email || '',
        preferred_currency: settings.preferred_currency || 'USD',
        tax_country: settings.tax_country || 'GLOBAL',
      });
      updated.push(receipt.id);
    }

    res.json({ updated_count: updated.length, ids: updated, message: 'Bulk review update complete' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const access = await getWorkspaceAccess(req.user.uid, req.user.email || '');
    await deleteReceipt(access.owner_uid, req.params.id);
    res.json({ message: 'Receipt deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
