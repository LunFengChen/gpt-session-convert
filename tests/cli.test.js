#!/usr/bin/env node

const assert = require('node:assert/strict');
const { convert, extractJSONValues } = require('../bin/gpt-session-convert.js');

const noisy = 'abc {} xxx {"user":{"email":"mark@example.com"},"accessToken":"access-token","sessionToken":"session-token","account":{"id":"acc_1","planType":"plus"}} tail {bad';
const values = extractJSONValues(noisy);
assert.equal(values.length, 2);

const cpa = convert(noisy, { format: 'cpa', extractJSON: true, proxyURL: 'http://127.0.0.1:8080' });
assert.equal(cpa.type, 'codex');
assert.equal(cpa.email, 'mark@example.com');
assert.equal(cpa.access_token, 'access-token');
assert.equal(cpa.proxy_url, 'http://127.0.0.1:8080');
assert.equal(cpa.id_token_synthetic, true);

console.log('cli tests passed');
