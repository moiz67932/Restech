if (process.env.RUN_REAL_PAELY_SANDBOX_CERTIFICATION !== 'true')
  throw new Error(
    'Refusing real sandbox calls. Set RUN_REAL_PAELY_SANDBOX_CERTIFICATION=true explicitly.',
  );
if (process.env.RESTEC_ENV !== 'sandbox')
  throw new Error('Certification requires RESTEC_ENV=sandbox.');
for (const name of [
  'PAELY_PRIVATE_BASE_URL',
  'PAELY_SERVICE_ID',
  'PAELY_PRIVATE_BEARER_TOKEN',
  'PAELY_PRIVATE_SIGNING_SECRET',
])
  if (!process.env[name]) throw new Error(`Missing ${name}.`);
console.log(
  'Real sandbox certification prerequisites validated. Run the documented signed bill, GET, payment, and callback sequence against the approved sandbox tenant.',
);
