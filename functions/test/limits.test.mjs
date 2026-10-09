// Limites effectives d'un cabinet (offre + surcharge) et délai de grâce après une baisse d'offre.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeEffectiveLimits, FALLBACK_LIMITS } = require('../lib/shared/index.js');
const { graceUpdate } = require('../lib/core/seats.utils.js');
const { Timestamp } = require('firebase-admin/firestore');

const essentiel = { limits: { maxUtilisateurs: 3, resetsAppareilParMois: 2, appelsIaParMois: 200, maxAppareilsParUtilisateur: 1, delaiGraceJours: 14 } };

describe('computeEffectiveLimits', () => {
  it("reprend les limites de l'offre", () => {
    assert.deepEqual(computeEffectiveLimits(essentiel), essentiel.limits);
  });

  it('passer de 3 à 6 sièges par surcharge, sans toucher aux autres limites', () => {
    assert.deepEqual(computeEffectiveLimits(essentiel, { maxUtilisateurs: 6 }), { ...essentiel.limits, maxUtilisateurs: 6 });
  });

  it('une surcharge à 0 est respectée (elle ne retombe pas sur l’offre)', () => {
    assert.equal(computeEffectiveLimits(essentiel, { resetsAppareilParMois: 0 }).resetsAppareilParMois, 0);
  });

  it('sans offre (catalogue non publié), applique les limites par défaut', () => {
    assert.deepEqual(computeEffectiveLimits(null), FALLBACK_LIMITS);
  });

  it('une offre publiée avant les appareils multiples et le délai de grâce par offre reçoit les valeurs par défaut', () => {
    const ancienne = { limits: { maxUtilisateurs: 3, resetsAppareilParMois: 2, appelsIaParMois: 200 } };
    const limits = computeEffectiveLimits(ancienne);
    assert.equal(limits.maxAppareilsParUtilisateur, 1);
    assert.equal(limits.delaiGraceJours, 14);
    assert.equal(computeEffectiveLimits(ancienne, { maxAppareilsParUtilisateur: 2 }).maxAppareilsParUtilisateur, 2);
  });
});

describe('graceUpdate (délai de grâce)', () => {
  const inTheFuture = Timestamp.fromMillis(Date.now() + 86_400_000);

  it('ouvre le délai quand les membres actifs dépassent la limite', () => {
    const update = graceUpdate(5, 3, null);
    assert.ok(update.graceEndsAt.toMillis() > Date.now());
  });

  it("applique le délai de grâce de l'offre", () => {
    const update = graceUpdate(5, 3, null, 30);
    const days = (update.graceEndsAt.toMillis() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30);
  });

  it('ne prolonge pas un délai déjà ouvert', () => {
    assert.deepEqual(graceUpdate(5, 3, inTheFuture), {});
  });

  it('referme le délai dès que le cabinet rentre dans sa limite', () => {
    assert.ok('graceEndsAt' in graceUpdate(3, 3, inTheFuture));
    assert.deepEqual(graceUpdate(3, 3, null), {});
  });
});
