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

const handleLimiter = createRateLimiter({
  name: 'ranked handle claim',
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req) => req.user?.uid || req.ip,
});

const ADULT_INSTITUTION_TYPES = new Set(['college', 'company']);
const SCHOOL_BLOCKLIST = /\b(k-?12|school|public school|high school|middle school|primary|secondary|academy)\b/i;
const SOCIAL_FIELDS = ['instagram', 'tiktok', 'twitter', 'youtube', 'snapchat', 'website'];
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED_HANDLES = new Set(['admin', 'ranked', 'moggoff', 'support', 'help', 'api', 'root', 'me', 'null', 'undefined']);

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
    const candidates = await attachOwnerProfiles(snap.docs.map(serializeDoc));
    res.json({ candidates });
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
    const candidates = await attachOwnerProfiles(snap.docs.map(serializeDoc));
    res.json({ candidates });
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

    // Vote model: a person may hold at most ONE upvote and ONE downvote per
    // institution (across every candidate listed there, on either board).
    // Each slot is a single doc keyed by institution+voter+direction whose
    // `candidateId` field points at whoever currently holds that slot, so
    // casting a new vote in a direction automatically MOVES it off the old
    // candidate. A person can never hold both directions on the same
    // candidate - claiming one direction on someone auto-clears the other.
    const oppositeDirection = direction === 'up' ? 'down' : 'up';

    const result = await db.runTransaction(async (tx) => {
      const candidateRef = db.collection('candidates').doc(candidateId);
      const candidateSnap = await tx.get(candidateRef);
      if (!candidateSnap.exists || candidateSnap.data()?.status !== 'confirmed') {
        throw Object.assign(new Error('Candidate not found'), { status: 404 });
      }
      const institutionId = candidateSnap.data().institutionId;

      const sameSlotRef = db.collection('votes').doc(`${institutionId}_${req.user.uid}_${direction}`);
      const oppositeSlotRef = db.collection('votes').doc(`${institutionId}_${req.user.uid}_${oppositeDirection}`);
      const [sameSlotSnap, oppositeSlotSnap] = await Promise.all([tx.get(sameSlotRef), tx.get(oppositeSlotRef)]);
      const sameSlot = sameSlotSnap.exists ? sameSlotSnap.data() : null;
      const oppositeSlot = oppositeSlotSnap.exists ? oppositeSlotSnap.data() : null;

      // Collect every OTHER candidate doc we might need to adjust, reading
      // them all before any writes (Firestore transactions require reads
      // before writes).
      const candidates = new Map([[candidateId, { ref: candidateRef, data: { ...candidateSnap.data() } }]]);
      const otherIdsToLoad = new Set();
      if (sameSlot?.candidateId && sameSlot.candidateId !== candidateId) otherIdsToLoad.add(sameSlot.candidateId);
      for (const otherId of otherIdsToLoad) {
        const ref = db.collection('candidates').doc(otherId);
        const snap = await tx.get(ref);
        if (snap.exists) candidates.set(otherId, { ref, data: { ...snap.data() } });
      }

      const bump = (id, dir, delta) => {
        const entry = candidates.get(id);
        if (!entry) return;
        const key = dir === 'up' ? 'upvotes' : 'downvotes';
        entry.data[key] = Math.max(0, Number(entry.data[key] || 0) + delta);
      };

      let activeDirection = direction;

      if (sameSlot && sameSlot.candidateId === candidateId) {
        // Clicking the same direction they already have on this candidate: retract it.
        bump(candidateId, direction, -1);
        tx.delete(sameSlotRef);
        activeDirection = null;
      } else {
        // Moving (or newly casting) this direction onto `candidateId`.
        if (sameSlot?.candidateId) bump(sameSlot.candidateId, direction, -1);
        // Can't hold both directions on the same person - clear the opposite if it's here.
        if (oppositeSlot?.candidateId === candidateId) {
          bump(candidateId, oppositeDirection, -1);
          tx.delete(oppositeSlotRef);
        }
        bump(candidateId, direction, 1);
        tx.set(sameSlotRef, {
          institutionId,
          voterUid: req.user.uid,
          voterEmail: req.user.email || '',
          direction,
          candidateId,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      for (const { ref, data } of candidates.values()) {
        tx.update(ref, {
          upvotes: data.upvotes,
          downvotes: data.downvotes,
          score: data.upvotes - data.downvotes,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      tx.create(db.collection('ranked_audit').doc(), buildAudit('vote_updated', req.user, {
        candidateId,
        direction: activeDirection || 'retracted',
      }));

      const finalCandidate = candidates.get(candidateId).data;
      return {
        candidateId,
        direction: activeDirection,
        upvotes: finalCandidate.upvotes,
        downvotes: finalCandidate.downvotes,
        score: finalCandidate.upvotes - finalCandidate.downvotes,
      };
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
    const targetHandleInput = normalizeHandle(req.body?.targetHandle);

    if (!candidateName || !institutionId || !gender) {
      return res.status(400).json({ error: 'candidateName, institutionId, and gender are required.' });
    }
    if (!targetHandleInput) {
      return res.status(400).json({ error: "Enter the nominee's handle. They need a MOGGOFF account to be nominated." });
    }

    const institution = await getApprovedAdultInstitution(institutionId);
    const normalizedName = normalizeName(candidateName);

    const handleSnap = await db.collection('handles').doc(targetHandleInput).get();
    if (!handleSnap.exists) {
      return res.status(404).json({
        error: `No account found with the handle @${targetHandleInput}. They need a MOGGOFF account to be nominated.`,
      });
    }
    const targetUid = handleSnap.data().uid;
    const targetHandle = targetHandleInput;

    const alreadyListed = await db.collection('candidates')
      .where('institutionId', '==', institutionId)
      .where('gender', '==', gender)
      .where('confirmedUid', '==', targetUid)
      .where('status', '==', 'confirmed')
      .limit(1)
      .get();
    if (!alreadyListed.empty) {
      return res.status(409).json({ error: 'This person is already ranked at that institution.' });
    }

    const pendingForTarget = await db.collection('nominations')
      .where('institutionId', '==', institutionId)
      .where('targetUid', '==', targetUid)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    if (!pendingForTarget.empty) {
      return res.status(409).json({ error: 'This person already has a pending nomination request at that institution.' });
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
      targetUid,
      targetHandle,
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
    });
  } catch (err) {
    next(err);
  }
});

// ── Handles ─────────────────────────────────────────────────────────────
router.post('/me/handle', authMiddleware, handleLimiter, async (req, res, next) => {
  try {
    const handle = normalizeHandle(req.body?.handle);
    if (!handle) {
      return res.status(400).json({ error: 'Handles must be 3-20 characters: letters, numbers, and underscores only.' });
    }
    if (RESERVED_HANDLES.has(handle)) {
      return res.status(409).json({ error: 'That handle is reserved.' });
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const handleRef = db.collection('handles').doc(handle);

    await db.runTransaction(async (tx) => {
      const [userSnap, handleSnap] = await Promise.all([tx.get(userRef), tx.get(handleRef)]);
      if (handleSnap.exists && handleSnap.data()?.uid !== req.user.uid) {
        throw Object.assign(new Error('That handle is already taken.'), { status: 409 });
      }
      const existingHandle = userSnap.exists ? userSnap.data()?.handle : null;
      if (existingHandle && existingHandle !== handle) {
        tx.delete(db.collection('handles').doc(existingHandle));
      }
      tx.set(handleRef, { uid: req.user.uid, createdAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(userRef, { handle, email: req.user.email || '', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });

    res.json({ handle });
  } catch (err) {
    next(err);
  }
});

router.get('/handles/:handle', async (req, res, next) => {
  try {
    const handle = normalizeHandle(req.params.handle);
    if (!handle) return res.status(400).json({ error: 'Invalid handle.' });
    const snap = await db.collection('handles').doc(handle).get();
    if (!snap.exists) return res.status(404).json({ error: 'No account with that handle.' });
    res.json({ handle });
  } catch (err) {
    next(err);
  }
});

// ── Site-wide profile (banner, avatar, bio, social links) ────────────────
// One shared identity per person, reused across every institution they're
// listed at - editing it here updates every listing at once.
router.get('/users/:handle', async (req, res, next) => {
  try {
    const handle = normalizeHandle(req.params.handle);
    if (!handle) return res.status(400).json({ error: 'Invalid handle.' });
    const handleSnap = await db.collection('handles').doc(handle).get();
    if (!handleSnap.exists) return res.status(404).json({ error: 'No account with that handle.' });
    const uid = handleSnap.data().uid;
    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};
    const listingsSnap = await db.collection('candidates')
      .where('confirmedUid', '==', uid)
      .where('status', '==', 'confirmed')
      .get();

    const listings = await Promise.all(listingsSnap.docs.map(async (doc) => {
      const item = serializeDoc(doc);
      const peersSnap = await db.collection('candidates')
        .where('institutionId', '==', item.institutionId)
        .where('gender', '==', item.gender)
        .where('status', '==', 'confirmed')
        .orderBy('score', 'desc')
        .get();
      const rank = peersSnap.docs.findIndex((peer) => peer.id === item.id) + 1;
      return {
        id: item.id,
        name: item.name,
        gender: item.gender,
        institutionId: item.institutionId,
        institutionName: item.institutionName,
        score: item.score,
        rank: rank || null,
      };
    }));

    res.json({
      profile: {
        handle,
        displayName: userData.displayName || null,
        avatarURL: userData.avatarURL || null,
        bannerURL: userData.bannerURL || null,
        bio: userData.bio || '',
        socialLinks: userData.socialLinks || {},
      },
      listings,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/me/profile', authMiddleware, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = { updatedAt: FieldValue.serverTimestamp() };
    if (typeof body.displayName === 'string') patch.displayName = cleanName(body.displayName) || null;
    if (typeof body.bio === 'string') patch.bio = body.bio.trim().slice(0, 280);
    if (body.socialLinks && typeof body.socialLinks === 'object') {
      for (const field of SOCIAL_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(body.socialLinks, field)) continue;
        const raw = String(body.socialLinks[field] || '').trim();
        patch[`socialLinks.${field}`] = raw ? (cleanUrl(raw) || null) : null;
      }
    }
    await db.collection('users').doc(req.user.uid).set(patch, { merge: true });
    await db.collection('ranked_audit').add(buildAudit('profile_updated', req.user, {}));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/me/avatar', authMiddleware, async (req, res, next) => {
  try {
    const photoURL = cleanUrl(req.body?.photoURL);
    if (!photoURL) return res.status(400).json({ error: 'photoURL is required.' });
    await db.collection('users').doc(req.user.uid).set({ avatarURL: photoURL, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/me/banner', authMiddleware, async (req, res, next) => {
  try {
    const photoURL = cleanUrl(req.body?.photoURL);
    if (!photoURL) return res.status(400).json({ error: 'photoURL is required.' });
    await db.collection('users').doc(req.user.uid).set({ bannerURL: photoURL, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Nomination requests (inbox for the person who was nominated) ─────────
router.get('/me/requests', authMiddleware, async (req, res, next) => {
  try {
    const snap = await db.collection('nominations')
      .where('targetUid', '==', req.user.uid)
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .get();
    res.json({ requests: snap.docs.map(serializeDoc) });
  } catch (err) {
    next(err);
  }
});

router.post('/nominations/:id/confirm', authMiddleware, async (req, res, next) => {
  try {
    const nominationId = String(req.params.id);
    const result = await db.runTransaction(async (tx) => {
      const nominationRef = db.collection('nominations').doc(nominationId);
      const nominationSnap = await tx.get(nominationRef);
      if (!nominationSnap.exists) throw Object.assign(new Error('Nomination not found.'), { status: 404 });
      const nomination = nominationSnap.data() || {};
      // The one check that actually matters: only the person this nomination
      // targets can confirm it. Nobody else - not even with a copy of a link.
      if (nomination.status !== 'pending' || nomination.targetUid !== req.user.uid) {
        throw Object.assign(new Error('This nomination is not yours to confirm.'), { status: 403 });
      }
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
        confirmToken: nomination.confirmToken || uuidv4().replace(/-/g, ''),
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
      tx.update(nominationRef, {
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
        nominationId,
        candidateId: candidateRef.id,
      }));

      return { id: candidateRef.id, ...candidate };
    });

    res.status(201).json({ candidate: result });
  } catch (err) {
    next(err);
  }
});

router.post('/nominations/:id/decline', authMiddleware, async (req, res, next) => {
  try {
    const nominationId = String(req.params.id);
    const ref = db.collection('nominations').doc(nominationId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Nomination not found.' });
    const nomination = snap.data() || {};
    if (nomination.status !== 'pending' || nomination.targetUid !== req.user.uid) {
      return res.status(403).json({ error: 'This nomination is not yours to decline.' });
    }
    await ref.update({
      status: 'flagged',
      flagReason: String(req.body?.reason || 'Candidate says this is not them').slice(0, 240),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db.collection('ranked_audit').add(buildAudit('nomination_flagged', req.user, { nominationId }));
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
    const [candidate] = await attachOwnerProfiles([serializeDoc(snap)]);
    res.json({ candidate, rank, totalConfirmed });
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
      handle: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await ref.set(doc, { merge: true });
    return { uid: user.uid, email: user.email || '', isAdmin: doc.isAdmin, handle: null };
  }
  const data = snap.data() || {};
  const patch = {};
  if (user.email && data.email !== user.email) patch.email = user.email;
  if (isEnvAdmin && !data.isAdmin) patch.isAdmin = true;
  if (Object.keys(patch).length) {
    patch.updatedAt = FieldValue.serverTimestamp();
    await ref.set(patch, { merge: true });
  }
  return {
    uid: user.uid,
    email: user.email || data.email || '',
    isAdmin: Boolean(data.isAdmin || isEnvAdmin),
    handle: data.handle || null,
  };
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

function normalizeHandle(value) {
  const handle = String(value || '').trim().toLowerCase().replace(/^@/, '');
  return HANDLE_RE.test(handle) ? handle : null;
}

// Since the person's identity (avatar/bio/social links) is now one shared
// profile living on their `users/{uid}` doc, every candidate listing they
// hold needs that merged in - their own per-candidate fields are only a
// fallback for the (rare) case they haven't set up a profile yet.
async function attachOwnerProfiles(docs) {
  const uids = [...new Set(docs.map((doc) => doc.confirmedUid).filter(Boolean))];
  if (!uids.length) return docs;
  const snaps = await db.getAll(...uids.map((uid) => db.collection('users').doc(uid)));
  const profiles = new Map();
  snaps.forEach((snap) => { if (snap.exists) profiles.set(snap.id, snap.data() || {}); });
  return docs.map((doc) => {
    const profile = doc.confirmedUid ? profiles.get(doc.confirmedUid) : null;
    if (!profile) return doc;
    return {
      ...doc,
      photoURL: profile.avatarURL || doc.photoURL || null,
      bio: profile.bio || doc.bio || '',
      socialLinks: (profile.socialLinks && Object.keys(profile.socialLinks).length) ? profile.socialLinks : (doc.socialLinks || {}),
      displayName: profile.displayName || null,
      ownerHandle: profile.handle || null,
    };
  });
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
