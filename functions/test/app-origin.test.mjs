// Adresse de l'app dans les liens d'email : jamais une adresse choisie librement par le client.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { APP_ORIGINS, trustedAppOrigin } = require('../lib/core/config.js');

describe('trustedAppOrigin', () => {
  const emulator = process.env.FUNCTIONS_EMULATOR;
  afterEach(() => {
    if (emulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = emulator;
  });

  it("garde une adresse de l'app", () => {
    assert.equal(trustedAppOrigin(`${APP_ORIGINS[1]}/`), APP_ORIGINS[1]);
  });

  it("remplace une autre adresse par celle de l'app", () => {
    delete process.env.FUNCTIONS_EMULATOR;
    for (const value of ['https://phishing.example', 'http://localhost:4200', undefined, 42]) {
      assert.equal(trustedAppOrigin(value), APP_ORIGINS[0], String(value));
    }
  });

  it('accepte localhost dans les emulators seulement', () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    assert.equal(trustedAppOrigin('http://localhost:4200'), 'http://localhost:4200');
    assert.equal(trustedAppOrigin('http://localhost.evil.example'), APP_ORIGINS[0]);
  });
});
