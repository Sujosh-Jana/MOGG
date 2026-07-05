const express = require('express');
const { v4: uuidv4 } = require('uuid');
const admin = require('../services/firebase');
const authMiddleware = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const voteLimiter = createRateLimiter({
  name: 'ranked vote',
  windowMs: 60_000,
  max: 45,
  keyGenerator: (req) => req.user?.uid || req.ip,
});
const nominationLimiter = createRateLimiter({
  name: 'ranked nomination',
  windowMs: 24 * 60 * 60_000,
  max: 20,
  keyGenerator: (req) => req.user?.uid || req.ip,
});
const adminLimiter = createRateLimiter({
  name: 'ranked admin',
  windowMs: 60_000,
  max: 180,
  keyGenerator: (req) => req.user?.uid || req.ip,
});

const ADULT_INSTITUTION_TYPES = new Set(['college', 'company']);
const SCHOOL_BLOCKLIST = /\b(k-?12|school|public school|high school|middle school|primary|secondary|academy)\b/i;
const SOCIAL_FIELDS = ['instagram', 'tiktok', 'twitter', 'youtube', 'snapchat', 'website'];

router.get('/institutions', async (req, res, next) => {
  try {
    const includeAll = req.query.all === '1';
    let query = db.collection('institutions').orderBy('name');
    if (!includeAll) query = query.where('status', '==', 'approved');
    const snap = await query.get();
    res.json({ institutions: snap.docs.map(serializeDoc) });
  } catch (err) {
    next(err);
  }
});

router.get('/institutions/:id', async (req, res, next) => {
  try {
    const snap = await db.collection('institutions').doc(String(req.params.id)).get();
    if (!snap.exists) return res.status(404).json({ error: 'Institution not found' });
    res.json({ institution: serializeDoc(snap) });
  } catch (err) {
    next(err);
  }
});

router.get('/candidates', async (req, res, next) => {
  try {
    const institutionId = String(req.query.institutionId || '').trim();
    const gender = normalizeGender(req.query.gender);
    let query = db.collection('candidates').where('status', '==', 'confirmed').orderBy('score', 'desc');
    if (institutionId) query = query.where('institutionId', '==', institutionId);
    if (gender) query = query.where('gender', '==', gender);
    const snap = await query.get();
    res.json({ candidates: snap.docs.map(serializeDoc) });
  } catch (err) {
    next(err);
  }
});

router.get('/ticker', async (req, res, next) => {
  try {
    const snap = await db.collection('candidates')
      .where('status', '==', 'confirmed')
      .orderBy('score', 'desc')
      .limit(12)
      .get();
    res.json({ candidates: snap.docs.map(serializeDoc) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await ensureRankedUser(req.user);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.post('/votes', authMiddleware, voteLimiter, async (req, res, next) => {
  try {
    const candidateId = String(req.body?.candidateId || '').trim();
    const direction = normalizeDirection(req.body?.direction);
    if (!candidateId || !direction) {
      return res.status(400).json({ error: 'candidateId and direction are required.' });
    }

    const result = await db.runTransaction(async (tx) => {
      const candidateRef = db.collection('candidates').doc(candidateId);
      const voteRef = db.collection('votes').doc(`${candidateId}_${req.user.uid}`);
      const [candidateSnap, voteSnap] = await Promise.all([tx.get(candidateRef), tx.get(voteRef)]);
      if (!candidateSnap.exists || candidateSnap.data()?.status !== 'confirmed') {
        throw Object.assign(new Error('Candidate not found'), { status: 404 });
      }

      const current = candidateSnap.data() || {};
      let upvotes = Number(current.upvotes || 0);
      let downvotes = Number(current.downvotes || 0);
      const previous = voteSnap.exists ? voteSnap.data()?.direction : null;
      let activeDirection = direction;

      if (previous === direction) {
        if (direction === 'up') upvotes = Math.max(0, upvotes - 1);
        if (direction === 'down') downvotes = Math.max(0, downvotes - 1);
        tx.delete(voteRef);
        activeDirection = null;
      } else {
        if (previous === 'up') upvotes = Math.max(0, upvotes - 1);
        if (previous === 'down') downvotes = Math.max(0, downvotes - 1);
        if (direction === 'up') upvotes += 1;
        if (direction === 'down') downvotes += 1;
        tx.set(voteRef, {
          candidateId,
          institutionId: current.institutionId,
          voterUid: req.user.uid,
          voterEmail: req.user.email || '',
          direction,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      tx.update(candidateRef, {
        upvotes,
        downvotes,
        score: upvotes - downvotes,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(db.collection('ranked_audit').doc(), buildAudit('vote_updated', req.user, {
        candidateId,
        direction: activeDirection || 'retracted',
      }));

      return { candidateId, direction: activeDirection, upvotes, downvotes, score: upvotes - downvotes };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/votes', authMiddleware, async (req, res, next) => {
  try {
    const institutionId = String(req.query.institutionId || '').trim();
    if (!institutionId) return res.status(400).json({ error: 'institutionId is required.' });
    const snap = await db.collection('votes')
      .where('voterUid', '==', req.user.uid)
      .where('institutionId', '==', institutionId)
      .get();
    res.json({ votes: snap.docs.map(serializeDoc) });
  } catch (err) {
    next(err);
  }
});

router.post('/nominations', authMiddleware, nominationLimiter, async (req, res, next) => {
  try {
    const candidateName = cleanName(req.body?.candidateName || req.body?.name);
    const institutionId = String(req.body?.institutionId || '').trim();
    const gender = normalizeGender(req.body?.gender);
    const photoURL = cleanUrl(req.body?.photoURL);
    if (!candidateName || !institutionId || !gender) {
      return res.status(400).json({ error: 'candidateName, institutionId, and gender are required.' });
    }

    const institution = await getApprovedAdultInstitution(institutionId);
    const normalizedName = normalizeName(candidateName);
    const duplicate = await db.collection('nominations')
      .where('institutionId', '==', institutionId)
      .where('candidateNameNormalized', '==', normalizedName)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    if (!duplicate.empty) {
      return res.status(409).json({ error: 'This person already has a pending nomination at that institution.' });
    }

    const confirmToken = uuidv4().replace(/-/g, '');
    const doc = {
      candidateName,
      candidateNameNormalized: normalizedName,
      institutionId,
      institutionName: institution.name,
      gender,
      photoURL,
      nominatorUid: req.user.uid,
      nominatorEmail: req.user.email || '',
      status: 'pending',
      confirmToken,
      consentModel: 'candidate_must_confirm',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('nominations').add(doc);
    await db.collection('ranked_audit').add(buildAudit('nomination_created', req.user, {
      nominationId: ref.id,
      institutionId,
      candidateName,
    }));

    res.status(201).json({
      nomination: { id: ref.id, ...doc, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      confirmToken,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/confirm/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '').trim();
    const nomination = await findNominationByToken(token);
    const candidate = await findCandidateByToken(token);
    if (!nomination && !candidate) return res.status(404).json({ error: 'Confirmation link is invalid or expired.' });
    res.json({ nomination, candidate });
  } catch (err) {
    next(err);
  }
});

router.post('/confirm/:token', authMiddleware, async (req, res, next) => {
  try {
    const token = String(req.params.token || '').trim();
    const result = await db.runTransaction(async (tx) => {
      const nominationSnap = await queryOneInTransaction(tx, db.collection('nominations').where('confirmToken', '==', token).limit(1));
      if (!nominationSnap || nominationSnap.data()?.status !== 'pending') {
        throw Object.assign(new Error('This nomination cannot be confirmed.'), { status: 409 });
      }
      const nomination = nominationSnap.data() || {};
      await ensureInstitutionAllowedInTransaction(tx, nomination.institutionId);

      const candidateRef = db.collection('candidates').doc();
      const candidate = {
        name: nomination.candidateName,
        nameNormalized: nomination.candidateNameNormalized || normalizeName(nomination.candidateName),
        photoURL: cleanUrl(req.body?.photoURL) || nomination.photoURL || null,
        gender: nomination.gender,
        institutionId: nomination.institutionId,
        institutionName: nomination.institutionName || '',
        status: 'confirmed',
        confirmToken: token,
        nominatedBy: nomination.nominatorUid,
        confirmedUid: req.user.uid,
        confirmedEmail: req.user.email || '',
        upvotes: 0,
        downvotes: 0,
        score: 0,
        socialLinks: {},
        bio: '',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      tx.set(candidateRef, candidate);
      tx.update(nominationSnap.ref, {
        status: 'confirmed',
        confirmedUid: req.user.uid,
        confirmedEmail: req.user.email || '',
        candidateId: candidateRef.id,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(db.collection('institutions').doc(nomination.institutionId), {
        candidateCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(db.collection('ranked_audit').doc(), buildAudit('nomination_confirmed', req.user, {
        nominationId: nominationSnap.id,
        candidateId: candidateRef.id,
      }));

      return { id: candidateRef.id, ...candidate };
    });

    res.status(201).json({ candidate: result });
  } catch (err) {
    next(err);
  }
});

router.post('/confirm/:token/flag', async (req, res, next) => {
  try {
    const token = String(req.params.token || '').trim();
    const nomination = await findNominationByToken(token, true);
    if (!nomination || nomination.status !== 'pending') {
      return res.status(404).json({ error: 'Pending nomination not found.' });
    }
    await nomination.ref.update({
      status: 'flagged',
      flagReason: String(req.body?.reason || 'Candidate says this is not them').slice(0, 240),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db.collection('ranked_audit').add(buildAudit('nomination_flagged', { uid: 'public', email: '' }, {
      nominationId: nomination.id,
      reason: String(req.body?.reason || '').slice(0, 240),
    }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/candidates/:id', async (req, res, next) => {
  try {
    const ref = db.collection('candidates').doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.status !== 'confirmed') {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const data = snap.data() || {};
    let rank = null;
    let totalConfirmed = null;
    if (data.institutionId && data.gender) {
      const peers = await db.collection('candidates')
        .where('institutionId', '==', data.institutionId)
        .where('gender', '==', data.gender)
        .where('status', '==', 'confirmed')
        .orderBy('score', 'desc')
        .get();
      const index = peers.docs.findIndex((doc) => doc.id === snap.id);
      rank = index === -1 ? null : index + 1;
      totalConfirmed = peers.size;
    }
    res.json({ candidate: serializeDoc(snap), rank, totalConfirmed });
  } catch (err) {
    next(err);
  }
});

router.patch('/candidates/:id/profile', authMiddleware, async (req, res, next) => {
  try {
    const candidate = await getCandidateForOwnerOrAdmin(req.params.id, req.user);
    const body = req.body || {};
    const patch = { updatedAt: FieldValue.serverTimestamp() };

    if (body.socialLinks && typeof body.socialLinks === 'object') {
      for (const field of SOCIAL_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(body.socialLinks, field)) continue;
        const raw = String(body.socialLinks[field] || '').trim();
        patch[`socialLinks.${field}`] = raw ? (cleanUrl(raw) || null) : null;
      }
    }
    if (typeof body.bio === 'string') {
      patch.bio = body.bio.trim().slice(0, 280);
    }

    await candidate.ref.update(patch);
    await db.collection('ranked_audit').add(buildAudit('candidate_profile_updated', req.user, { candidateId: candidate.id }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/candidates/:id/photo', authMiddleware, async (req, res, next) => {
  try {
    const candidate = await getCandidateForOwnerOrAdmin(req.params.id, req.user);
    const photoURL = cleanUrl(req.body?.photoURL);
    if (!photoURL) return res.status(400).json({ error: 'photoURL is required.' });
    await candidate.ref.update({ photoURL, updatedAt: FieldValue.serverTimestamp() });
    await db.collection('ranked_audit').add(buildAudit('candidate_photo_updated', req.user, { candidateId: candidate.id }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/candidates/:id/opt-out', authMiddleware, async (req, res, next) => {
  try {
    const candidate = await getCandidateForOwnerOrAdmin(req.params.id, req.user);
    const batch = db.batch();
    batch.update(candidate.ref, {
      status: 'opted_out',
      optedOutAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (candidate.institutionId) {
      batch.update(db.collection('institutions').doc(candidate.institutionId), {
        candidateCount: FieldValue.increment(-1),
      });
    }
    const votes = await db.collection('votes').where('candidateId', '==', candidate.id).get();
    votes.docs.forEach((doc) => batch.delete(doc.ref));
    batch.create(db.collection('ranked_audit').doc(), buildAudit('candidate_opted_out', req.user, { candidateId: candidate.id }));
    await batch.commit();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.use('/admin', authMiddleware, adminLimiter, requireRankedAdmin);

router.get('/admin/overview', async (req, res, next) => {
  try {
    const [institutions, candidates, nominations, flagged, users] = await Promise.all([
      db.collection('institutions').get(),
      db.collection('candidates').where('status', '==', 'confirmed').get(),
      db.collection('nominations').where('status', '==', 'pending').get(),
      db.collection('nominations').where('status', '==', 'flagged').get(),
      db.collection('users').get(),
    ]);
    res.json({
      metrics: {
        institutions: institutions.size,
        candidates: candidates.size,
        pendingNominations: nominations.size,
        flaggedNominations: flagged.size,
        users: users.size,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/recalculate-scores', async (req, res, next) => {
  try {
    const snap = await db.collection('candidates').get();
    const batches = [];
    let batch = db.batch();
    let opCount = 0;
    const confirmedCountByInstitution = {};

    snap.docs.forEach((doc) => {
      const data = doc.data() || {};
      const upvotes = Number(data.upvotes || 0);
      const downvotes = Number(data.downvotes || 0);
      const correctScore = upvotes - downvotes;
      if (data.score !== correctScore) {
        batch.update(doc.ref, { score: correctScore });
        opCount += 1;
        if (opCount % 400 === 0) {
          batches.push(batch.commit());
          batch = db.batch();
        }
      }
      if (data.status === 'confirmed' && data.institutionId) {
        confirmedCountByInstitution[data.institutionId] = (confirmedCountByInstitution[data.institutionId] || 0) + 1;
      }
    });

    const institutionsSnap = await db.collection('institutions').get();
    let institutionsFixed = 0;
    institutionsSnap.docs.forEach((doc) => {
      const correctCount = confirmedCountByInstitution[doc.id] || 0;
      if ((doc.data().candidateCount || 0) !== correctCount) {
        batch.update(doc.ref, { candidateCount: correctCount });
        institutionsFixed += 1;
        opCount += 1;
        if (opCount % 400 === 0) {
          batches.push(batch.commit());
          batch = db.batch();
        }
      }
    });

    batches.push(batch.commit());
    await Promise.all(batches);
    await db.collection('ranked_audit').add(buildAudit('scores_recalculated', req.user, { candidatesUpdated: opCount, institutionsFixed }));
    res.json({ ok: true, updated: opCount, institutionsFixed });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/institutions', async (req, res, next) => {
  try {
    const name = cleanName(req.body?.name);
    const type = normalizeInstitutionType(req.body?.type);
    if (!name || !type) return res.status(400).json({ error: 'name and type are required.' });
    if (SCHOOL_BLOCKLIST.test(name)) {
      return res.status(400).json({ error: 'K-12 schools are not allowed. Use colleges, universities, or companies only.' });
    }

    const ref = await db.collection('institutions').add({
      name,
      nameNormalized: normalizeName(name),
      type,
      status: 'approved',
      candidateCount: 0,
      createdByUid: req.user.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db.collection('ranked_audit').add(buildAudit('institution_created', req.user, { institutionId: ref.id, name, type }));
    res.status(201).json({ institution: { id: ref.id, name, type, status: 'approved', candidateCount: 0 } });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/institutions/:id', async (req, res, next) => {
  try {
    const patch = {};
    if (req.body?.name != null) {
      const name = cleanName(req.body.name);
      if (!name || SCHOOL_BLOCKLIST.test(name)) return res.status(400).json({ error: 'Invalid institution name.' });
      patch.name = name;
      patch.nameNormalized = normalizeName(name);
    }
    if (req.body?.type != null) patch.type = normalizeInstitutionType(req.body.type);
    if (req.body?.status != null) patch.status = normalizeInstitutionStatus(req.body.status);
    Object.keys(patch).forEach((key) => patch[key] == null && delete patch[key]);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields to update.' });
    patch.updatedAt = FieldValue.serverTimestamp();
    await db.collection('institutions').doc(String(req.params.id)).set(patch, { merge: true });
    await db.collection('ranked_audit').add(buildAudit('institution_updated', req.user, { institutionId: req.params.id, patch }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/admin/institutions/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const candidates = await db.collection('candidates')
      .where('institutionId', '==', id)
      .where('status', '==', 'confirmed')
      .limit(1)
      .get();
    if (!candidates.empty) {
      return res.status(409).json({ error: 'Remove or opt out candidates before deleting this institution.' });
    }
    await db.collection('institutions').doc(id).delete();
    await db.collection('ranked_audit').add(buildAudit('institution_deleted', req.user, { institutionId: id }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/nominations', async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    let query = db.collection('nominations').orderBy('createdAt', 'desc').limit(100);
    if (['pending', 'flagged', 'confirmed', 'rejected'].includes(status)) query = db.collection('nominations').where('status', '==', status).orderBy('createdAt', 'desc').limit(100);
    const snap = await query.get();
    res.json({ nominations: snap.docs.map(serializeDoc) });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/nominations/:id/reject', async (req, res, next) => {
  try {
    await db.collection('nominations').doc(String(req.params.id)).set({
      status: 'rejected',
      rejectionReason: String(req.body?.reason || '').slice(0, 240),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await db.collection('ranked_audit').add(buildAudit('nomination_rejected', req.user, { nominationId: req.params.id }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/candidates', async (req, res, next) => {
  try {
    const name = cleanName(req.body?.name);
    const institutionId = String(req.body?.institutionId || '').trim();
    const gender = normalizeGender(req.body?.gender);
    const photoURL = cleanUrl(req.body?.photoURL);
    if (!name || !institutionId || !gender) return res.status(400).json({ error: 'name, institutionId, and gender are required.' });
    const institution = await getApprovedAdultInstitution(institutionId);
    const ref = await db.collection('candidates').add({
      name,
      nameNormalized: normalizeName(name),
      photoURL,
      gender,
      institutionId,
      institutionName: institution.name,
      status: 'confirmed',
      confirmToken: `admin-${uuidv4().replace(/-/g, '')}`,
      nominatedBy: req.user.uid,
      confirmedUid: req.user.uid,
      confirmedEmail: req.user.email || '',
      upvotes: 0,
      downvotes: 0,
      score: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db.collection('institutions').doc(institutionId).update({
      candidateCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db.collection('ranked_audit').add(buildAudit('candidate_admin_created', req.user, { candidateId: ref.id, institutionId, name }));
    res.status(201).json({ candidate: { id: ref.id, name, institutionId, institutionName: institution.name, gender, photoURL, status: 'confirmed', upvotes: 0, downvotes: 0, score: 0 } });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/candidates', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'confirmed');
    let query = db.collection('candidates').orderBy('createdAt', 'desc').limit(120);
    if (status) query = db.collection('candidates').where('status', '==', status).orderBy('createdAt', 'desc').limit(120);
    const snap = await query.get();
    res.json({ candidates: snap.docs.map(serializeDoc) });
  } catch (err) {
    next(err);
  }
});

router.delete('/admin/candidates/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const ref = db.collection('candidates').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Candidate not found.' });
    const candidateData = snap.data() || {};
    const batch = db.batch();
    batch.update(ref, { status: 'removed_by_admin', updatedAt: FieldValue.serverTimestamp() });
    if (candidateData.institutionId) {
      batch.update(db.collection('institutions').doc(candidateData.institutionId), {
        candidateCount: FieldValue.increment(-1),
      });
    }
    const votes = await db.collection('votes').where('candidateId', '==', id).get();
    votes.docs.forEach((doc) => batch.delete(doc.ref));
    batch.create(db.collection('ranked_audit').doc(), buildAudit('candidate_admin_removed', req.user, { candidateId: id }));
    await batch.commit();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/audit', async (req, res, next) => {
  try {
    const snap = await db.collection('ranked_audit').orderBy('at', 'desc').limit(80).get();
    res.json({ events: snap.docs.map(serializeDoc) });
  } catch (err) {
    next(err);
  }
});

async function ensureRankedUser(user) {
  const ref = db.collection('users').doc(String(user.uid));
  const snap = await ref.get();
  const adminEmails = parseAdminEmails();
  const isEnvAdmin = adminEmails.has(String(user.email || '').toLowerCase());
  if (!snap.exists) {
    const doc = {
      email: user.email || '',
      isAdmin: isEnvAdmin,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await ref.set(doc, { merge: true });
    return { uid: user.uid, email: user.email || '', isAdmin: doc.isAdmin };
  }
  const data = snap.data() || {};
  const patch = {};
  if (user.email && data.email !== user.email) patch.email = user.email;
  if (isEnvAdmin && !data.isAdmin) patch.isAdmin = true;
  if (Object.keys(patch).length) {
    patch.updatedAt = FieldValue.serverTimestamp();
    await ref.set(patch, { merge: true });
  }
  return { uid: user.uid, email: user.email || data.email || '', isAdmin: Boolean(data.isAdmin || isEnvAdmin) };
}

async function requireRankedAdmin(req, res, next) {
  try {
    const user = await ensureRankedUser(req.user);
    if (!user.isAdmin) return res.status(403).json({ error: 'Ranked admin access required.' });
    req.rankedUser = user;
    next();
  } catch (err) {
    next(err);
  }
}

async function getApprovedAdultInstitution(id) {
  const snap = await db.collection('institutions').doc(String(id)).get();
  if (!snap.exists) throw Object.assign(new Error('Institution not found.'), { status: 404 });
  const institution = snap.data() || {};
  if (institution.status !== 'approved') throw Object.assign(new Error('Institution is not approved.'), { status: 409 });
  if (!ADULT_INSTITUTION_TYPES.has(institution.type) || SCHOOL_BLOCKLIST.test(institution.name || '')) {
    throw Object.assign(new Error('Only adult colleges, universities, and companies are allowed.'), { status: 400 });
  }
  return { id: snap.id, ...institution };
}

async function ensureInstitutionAllowedInTransaction(tx, institutionId) {
  const snap = await tx.get(db.collection('institutions').doc(String(institutionId)));
  if (!snap.exists) throw Object.assign(new Error('Institution not found.'), { status: 404 });
  const data = snap.data() || {};
  if (data.status !== 'approved' || !ADULT_INSTITUTION_TYPES.has(data.type) || SCHOOL_BLOCKLIST.test(data.name || '')) {
    throw Object.assign(new Error('Institution is not eligible for rankings.'), { status: 400 });
  }
}

async function getCandidateForOwnerOrAdmin(id, user) {
  const ref = db.collection('candidates').doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('Candidate not found.'), { status: 404 });
  const data = snap.data() || {};
  const rankedUser = await ensureRankedUser(user);
  if (data.confirmedUid !== user.uid && !rankedUser.isAdmin) {
    throw Object.assign(new Error('You cannot manage this candidate.'), { status: 403 });
  }
  return { id: snap.id, ref, ...data };
}

async function findNominationByToken(token, includeRef = false) {
  const snap = await db.collection('nominations').where('confirmToken', '==', token).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = serializeDoc(doc);
  return includeRef ? { ...data, ref: doc.ref } : data;
}

async function findCandidateByToken(token) {
  const snap = await db.collection('candidates').where('confirmToken', '==', token).limit(1).get();
  if (snap.empty) return null;
  return serializeDoc(snap.docs[0]);
}

async function queryOneInTransaction(tx, query) {
  const snap = await tx.get(query);
  return snap.empty ? null : snap.docs[0];
}

function serializeDoc(doc) {
  return { id: doc.id, ...serializeValue(doc.data() || {}) };
}

function serializeValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, serializeValue(val)]));
}

function buildAudit(type, user = {}, meta = {}) {
  return {
    type,
    actorUid: user.uid || '',
    actorEmail: user.email || '',
    meta,
    at: FieldValue.serverTimestamp(),
  };
}

function parseAdminEmails() {
  return new Set(String(process.env.RANKED_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean));
}

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 90);
}

function normalizeName(value) {
  return cleanName(value).toLowerCase();
}

function cleanUrl(value) {
  const url = String(value || '').trim();
  if (!url) return null;
  if (url.startsWith('data:image/')) return url;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

function normalizeGender(value) {
  const gender = String(value || '').toLowerCase();
  return ['chad', 'stacy'].includes(gender) ? gender : null;
}

function normalizeDirection(value) {
  const direction = String(value || '').toLowerCase();
  return ['up', 'down'].includes(direction) ? direction : null;
}

function normalizeInstitutionType(value) {
  const type = String(value || '').toLowerCase();
  return ADULT_INSTITUTION_TYPES.has(type) ? type : null;
}

function normalizeInstitutionStatus(value) {
  const status = String(value || '').toLowerCase();
  return ['approved', 'hidden', 'pending'].includes(status) ? status : null;
}

module.exports = router;
