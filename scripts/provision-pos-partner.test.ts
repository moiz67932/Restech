import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProvisioningInput } from './provision-pos-partner.js';

const validInput = () => ({
  partner_name: 'Example partner',
  restaurant_name: 'Example restaurant',
  location_name: 'Example location',
  external_location_id: 'store-1',
  callback_url: 'https://pos.example.test/restec-events',
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  scopes: ['bills:read', 'bills:write'],
  allowed_ip_requirements: ['192.0.2.0/24', '2001:db8::/32'],
});

test('operator provisioning validates governed credential metadata', () => {
  assert.equal(validateProvisioningInput(validInput()).external_location_id, 'store-1');
  assert.throws(
    () => validateProvisioningInput({ ...validInput(), callback_url: 'http://pos.example.test' }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateProvisioningInput({
        ...validInput(),
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      }),
    /future ISO/,
  );
  assert.throws(
    () => validateProvisioningInput({ ...validInput(), scopes: ['database:admin'] }),
    /unsupported operation scope/,
  );
  assert.throws(
    () => validateProvisioningInput({ ...validInput(), allowed_ip_requirements: ['10.0.0.0/64'] }),
    /valid IPv4 or IPv6 CIDRs/,
  );
});
